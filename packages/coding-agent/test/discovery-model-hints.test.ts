import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Api,
	clampThinkingLevelForModel,
	type Effort,
	getSupportedEfforts,
	type Model,
	type OpenAICompat,
} from "@vib-rato/ai/core";
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

/** The same endpoint declared by hand, the way a models.yml author would. */
const DISCOVERY_PROVIDER = `providers:
  local:
    baseUrl: ${BASE_URL}
    api: openai-completions
    auth: none
    discovery:
      type: openai-models-list
`;

/** A `models[]` entry that contradicts everything the hint advertises. */
const DECLARED_VIB = `${DISCOVERY_PROVIDER}    models:
      - id: VIB
        name: Declared Name
        reasoning: false
        compat:
          supportsReasoningEffort: false
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

const NAMED_HINT = { ...VIB_HINT, name: "Server Name" };

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

async function discover(
	modelsPath: string,
	entries: Array<Record<string, unknown>>,
	prepare?: (registry: ModelRegistry) => void,
): Promise<Model<Api>[]> {
	using _hook = modelsListUpstream(entries);
	const authStorage = await AuthStorage.create(getAgentDbPath());
	const registry = new ModelRegistry(authStorage, modelsPath);
	try {
		prepare?.(registry);
		await registry.refreshProvider("local");
		expect(registry.getProviderDiscoveryState("local")?.status).toBe("ok");
		return registry.getAvailable().filter(model => model.provider === "local");
	} finally {
		authStorage.close();
	}
}

/** What the next start sees for VIB from the discovery cache alone, with no upstream. */
async function restoreFromCache(modelsPath: string): Promise<Model<Api> | undefined> {
	using _hook = hookFetch(() => new Response(null, { status: 503 }));
	const authStorage = await AuthStorage.create(getAgentDbPath());
	try {
		const registry = new ModelRegistry(authStorage, modelsPath);
		return registry.getAvailable().find(model => model.provider === "local" && model.id === "VIB");
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
		const vib = await restoreFromCache(modelsPath);
		expect(vib).toBeDefined();
		expect(efforts(vib)).toEqual(["low", "medium", "xhigh"]);
		expect(compatOf(vib)?.reasoningContentField).toBe("reasoning");
	});
});

describe("models-list discovery hints against declared configuration", () => {
	const expectDeclarationKept = (vib: Model<Api> | undefined) => {
		expect(vib?.name).toBe("Declared Name");
		expect(vib?.reasoning).toBe(false);
		expect(vib?.thinking).toBeUndefined();
		expect(compatOf(vib)?.supportsReasoningEffort).toBe(false);
		expect(efforts(vib)).toEqual([]);
		// A field the declaration leaves unset still comes from the hint.
		expect(compatOf(vib)?.reasoningContentField).toBe("reasoning");
	};

	it("keeps a same-id models[] declaration ahead of the hint after live discovery", async () => {
		const modelsPath = await tempAgent(DECLARED_VIB);
		const [vib] = await discover(modelsPath, [{ id: "VIB", vibrato: NAMED_HINT }]);
		expectDeclarationKept(vib);
	});

	it("keeps a same-id models[] declaration ahead of the cached hint at the next start", async () => {
		const modelsPath = await tempAgent(DECLARED_VIB);
		await discover(modelsPath, [{ id: "VIB", vibrato: NAMED_HINT }]);
		expectDeclarationKept(await restoreFromCache(modelsPath));
	});

	it("fills whatever a models[] declaration leaves unset", async () => {
		const modelsPath = await tempAgent(`${DISCOVERY_PROVIDER}    models:
      - id: VIB
`);
		const [vib] = await discover(modelsPath, [{ id: "VIB", vibrato: NAMED_HINT }]);
		expect(vib?.name).toBe("Server Name");
		expect(vib?.reasoning).toBe(true);
		expect(efforts(vib)).toEqual(["low", "medium", "xhigh"]);
		expect(compatOf(vib)?.supportsReasoningEffort).toBe(true);
	});

	it("keeps provider-level compat from models.yml ahead of the hint, live and from the cache", async () => {
		// Unlike the registry's own supportsReasoningEffort: false default for a
		// bare endpoint, which the hint is meant to lift, an explicit provider
		// compat is the user's word and stays.
		const modelsPath = await tempAgent(`providers:
  local:
    baseUrl: ${BASE_URL}
    api: openai-completions
    auth: none
    compat:
      supportsReasoningEffort: false
      reasoningContentField: reasoning_content
    discovery:
      type: openai-models-list
`);
		const expectProviderCompatKept = (vib: Model<Api> | undefined) => {
			expect(compatOf(vib)?.supportsReasoningEffort).toBe(false);
			expect(compatOf(vib)?.reasoningContentField).toBe("reasoning_content");
			expect(efforts(vib)).toEqual([]);
		};
		const [vib] = await discover(modelsPath, [{ id: "VIB", vibrato: VIB_HINT }]);
		expectProviderCompatKept(vib);
		expectProviderCompatKept(await restoreFromCache(modelsPath));
	});

	it("keeps a runtime registerProvider model declaration ahead of the hint", async () => {
		const modelsPath = await tempAgent(DISCOVERY_PROVIDER);
		const [vib] = await discover(modelsPath, [{ id: "VIB", vibrato: NAMED_HINT }], registry =>
			registry.registerProvider("local", {
				baseUrl: BASE_URL,
				api: "openai-completions",
				apiKey: "runtime-test-key",
				models: [
					{
						id: "VIB",
						name: "Declared Name",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 4096,
						maxTokens: 1024,
						compat: { supportsReasoningEffort: false },
					},
				],
			}),
		);
		expectDeclarationKept(vib);
	});
});

describe("models-list discovery hint level sets", () => {
	const hintWithThinking = (thinking: Record<string, unknown>) => ({
		reasoning: true,
		thinking,
		compat: { supportsReasoningEffort: true },
	});
	const expectHintIgnored = (vib: Model<Api> | undefined) => {
		expect(vib?.id).toBe("VIB");
		expect(vib?.reasoning).toBe(false);
		expect(vib?.thinking).toBeUndefined();
		expect(compatOf(vib)?.supportsReasoningEffort).toBe(false);
		expect(efforts(vib)).toEqual([]);
	};

	it("ignores a hint whose range runs downward instead of inferring a full range", async () => {
		const modelsPath = await tempAgent(LOCAL_PROVIDER);
		const [vib] = await discover(modelsPath, [
			{ id: "VIB", vibrato: hintWithThinking({ minLevel: "xhigh", maxLevel: "low", mode: "effort" }) },
		]);
		expectHintIgnored(vib);
	});

	it("ignores a hint with an empty level set", async () => {
		const modelsPath = await tempAgent(LOCAL_PROVIDER);
		const [vib] = await discover(modelsPath, [
			{ id: "VIB", vibrato: hintWithThinking({ minLevel: "low", maxLevel: "xhigh", levels: [], mode: "effort" }) },
		]);
		expectHintIgnored(vib);
	});

	it("ignores a hint whose levels fall outside its own range", async () => {
		const modelsPath = await tempAgent(LOCAL_PROVIDER);
		const [vib] = await discover(modelsPath, [
			{
				id: "VIB",
				vibrato: hintWithThinking({
					minLevel: "low",
					maxLevel: "medium",
					levels: ["low", "xhigh"],
					mode: "effort",
				}),
			},
		]);
		expectHintIgnored(vib);
	});

	it("ignores a hint whose default is not an advertised level", async () => {
		const modelsPath = await tempAgent(LOCAL_PROVIDER);
		const [vib] = await discover(modelsPath, [
			{
				id: "VIB",
				vibrato: hintWithThinking({
					minLevel: "low",
					maxLevel: "xhigh",
					levels: ["low", "medium", "xhigh"],
					defaultLevel: "high",
					mode: "effort",
				}),
			},
		]);
		expectHintIgnored(vib);
	});

	it("orders an unordered level set so clamping picks the nearest lower level", async () => {
		const modelsPath = await tempAgent(LOCAL_PROVIDER);
		const [vib] = await discover(modelsPath, [
			{
				id: "VIB",
				vibrato: hintWithThinking({
					minLevel: "low",
					maxLevel: "xhigh",
					levels: ["xhigh", "medium", "low", "medium"],
					mode: "effort",
				}),
			},
		]);
		expect(efforts(vib)).toEqual(["low", "medium", "xhigh"]);
		expect(String(clampThinkingLevelForModel(vib, "high" as Effort))).toBe("medium");
	});
});
