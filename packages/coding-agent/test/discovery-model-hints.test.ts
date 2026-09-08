import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Api, getSupportedEfforts, type Model, type OpenAICompat } from "@vib-rato/ai/core";
import { getAgentDbPath, getAgentDir, hookFetch, setAgentDir } from "@vib-rato/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { AuthStorage } from "../src/session/auth-storage";

let tempRoot: string | undefined;
const originalAgentDir = getAgentDir();

async function tempAgent(modelsYaml: string): Promise<string> {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vib-discovery-model-hints-"));
	const agentDir = path.join(tempRoot, "agent");
	await fs.mkdir(agentDir, { recursive: true });
	setAgentDir(agentDir);
	const modelsPath = path.join(agentDir, "models.yml");
	await fs.writeFile(modelsPath, modelsYaml, { mode: 0o600 });
	return modelsPath;
}

afterEach(async () => {
	setAgentDir(originalAgentDir);
	if (tempRoot) {
		await fs.rm(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	}
});

const BASE_URL = "http://10.0.0.9:8788/v1";

const LOCAL_PROVIDER = `providers:
  local:
    openaiCompat:
      baseUrl: ${BASE_URL}
`;

/** The hint the LIG gateway advertises for its vLLM model. */
const VIB_HINT = {
	reasoning: true,
	thinking: {
		minLevel: "low",
		maxLevel: "xhigh",
		levels: ["low", "medium", "xhigh"],
		defaultLevel: "medium",
		mode: "effort",
	},
	compat: { supportsReasoningEffort: true, reasoningContentField: "reasoning" },
};

const efforts = (model: Model<Api> | undefined): string[] => (model ? (getSupportedEfforts(model) as string[]) : []);
const compatOf = (model: Model<Api> | undefined): OpenAICompat | undefined => model?.compat as OpenAICompat | undefined;

/** A models list whose entries carry whatever `vibrato` value the test wants. */
function modelsListUpstream(entries: Array<Record<string, unknown>>) {
	return hookFetch(input => {
		if (String(input) !== `${BASE_URL}/models`) return new Response(null, { status: 404 });
		return new Response(JSON.stringify({ object: "list", data: entries }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
}

async function discover(modelsPath: string, entries: Array<Record<string, unknown>>): Promise<Model<Api>[]> {
	using _hook = modelsListUpstream(entries);
	const authStorage = await AuthStorage.create(getAgentDbPath());
	const registry = new ModelRegistry(authStorage, modelsPath);
	try {
		await registry.refreshProvider("local");
		expect(registry.getProviderDiscoveryState("local")?.status).toBe("ok");
		return registry.getAvailable().filter(model => model.provider === "local");
	} finally {
		authStorage.close();
	}
}

describe("models-list discovery hints", () => {
	it("turns a hinted entry into a reasoning model with the advertised levels", async () => {
		const modelsPath = await tempAgent(LOCAL_PROVIDER);
		const [vib] = await discover(modelsPath, [{ id: "VIB", max_model_len: 212144, vibrato: VIB_HINT }]);
		expect(vib).toBeDefined();
		expect(vib?.reasoning).toBe(true);
		expect(efforts(vib)).toEqual(["low", "medium", "xhigh"]);
		expect(String(vib?.thinking?.defaultLevel)).toBe("medium");
		expect(compatOf(vib)?.supportsReasoningEffort).toBe(true);
		expect(compatOf(vib)?.reasoningContentField).toBe("reasoning");
		// Discovery's own defaults for a local endpoint stay in place.
		expect(compatOf(vib)?.supportsStore).toBe(false);
		expect(vib?.contextWindow).toBe(212144);
	});

	it("leaves an entry without a hint exactly as discovery builds it", async () => {
		const modelsPath = await tempAgent(LOCAL_PROVIDER);
		const models = await discover(modelsPath, [
			{ id: "VIB", vibrato: VIB_HINT },
			{ id: "plain", max_model_len: 4096 },
		]);
		const plain = models.find(model => model.id === "plain");
		expect(plain?.reasoning).toBe(false);
		expect(plain?.thinking).toBeUndefined();
		expect(compatOf(plain)?.supportsReasoningEffort).toBe(false);
		expect(efforts(plain)).toEqual([]);
	});

	it("ignores a malformed hint whole and keeps the model listed", async () => {
		const modelsPath = await tempAgent(LOCAL_PROVIDER);
		const [vib] = await discover(modelsPath, [
			{
				id: "VIB",
				vibrato: { reasoning: true, thinking: { minLevel: "low", maxLevel: "xhigh", mode: "bogus" } },
			},
		]);
		expect(vib?.id).toBe("VIB");
		expect(vib?.reasoning).toBe(false);
		expect(vib?.thinking).toBeUndefined();
	});

	it("ignores a hint that is not an object", async () => {
		const modelsPath = await tempAgent(LOCAL_PROVIDER);
		const [vib] = await discover(modelsPath, [{ id: "VIB", vibrato: "reasoning" }]);
		expect(vib?.id).toBe("VIB");
		expect(vib?.reasoning).toBe(false);
	});

	it("accepts only capability fields from the hint", async () => {
		const modelsPath = await tempAgent(LOCAL_PROVIDER);
		const [vib] = await discover(modelsPath, [
			{
				id: "VIB",
				vibrato: {
					...VIB_HINT,
					baseUrl: "http://evil.example/v1",
					headers: { Authorization: "Bearer stolen" },
					compat: { ...VIB_HINT.compat, extraBody: { x: 1 }, maxTokensField: "max_tokens" },
				},
			},
		]);
		expect(vib?.baseUrl).toBe(BASE_URL);
		expect(vib?.headers?.Authorization).toBeUndefined();
		expect(compatOf(vib)?.supportsReasoningEffort).toBe(true);
		expect(compatOf(vib)?.extraBody).toBeUndefined();
		expect(compatOf(vib)?.maxTokensField).toBeUndefined();
	});

	it("lets the user's modelOverrides win over the hint", async () => {
		const modelsPath = await tempAgent(`${LOCAL_PROVIDER}    modelOverrides:
      VIB:
        thinking:
          minLevel: low
          maxLevel: medium
          mode: effort
`);
		const [vib] = await discover(modelsPath, [{ id: "VIB", vibrato: VIB_HINT }]);
		expect(vib?.reasoning).toBe(true);
		expect(efforts(vib)).toEqual(["low", "medium"]);
	});

	it("keeps the hint in the discovery cache for the next start", async () => {
		const modelsPath = await tempAgent(LOCAL_PROVIDER);
		await discover(modelsPath, [{ id: "VIB", vibrato: VIB_HINT }]);
		// No upstream this time: whatever the next registry knows about VIB
		// came from the cache written by the discovery above.
		using _hook = hookFetch(() => new Response(null, { status: 503 }));
		const authStorage = await AuthStorage.create(getAgentDbPath());
		try {
			const registry = new ModelRegistry(authStorage, modelsPath);
			const vib = registry.getAvailable().find(model => model.provider === "local" && model.id === "VIB");
			expect(vib).toBeDefined();
			expect(efforts(vib)).toEqual(["low", "medium", "xhigh"]);
			expect(compatOf(vib)?.reasoningContentField).toBe("reasoning");
		} finally {
			authStorage.close();
		}
	});
});
