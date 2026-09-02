import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDbPath, getAgentDir, setAgentDir } from "@vib-rato/utils";
import { YAML } from "bun";
import {
	getSelectableOAuthProviders,
	hiddenBuiltInProviderIds,
	isProviderSelectable,
	NON_MODEL_OAUTH_PROVIDER_IDS,
	SELECTABLE_PROVIDER_IDS,
	selectableModels,
} from "../src/config/provider-allowlist";
import { SqliteAuthCredentialStore } from "../src/session/auth-storage";
import { addApiCompatibleProvider, PROVIDER_PRESETS } from "../src/setup/provider-onboarding";

let tempRoot: string | undefined;
const originalAgentDir = getAgentDir();

async function tempModelsPath(): Promise<string> {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vib-provider-allowlist-"));
	// Literal `apiKey` values route through AuthStorage at getAgentDbPath(); without
	// this the tests write real credential rows into the developer's ~/.vib/agent/agent.db.
	setAgentDir(path.join(tempRoot, "agent"));
	return path.join(tempRoot, "models.yml");
}

async function readProviders(modelsPath: string): Promise<Record<string, Record<string, unknown>>> {
	const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
		providers?: Record<string, Record<string, unknown>>;
	};
	return parsed.providers ?? {};
}

afterEach(async () => {
	setAgentDir(originalAgentDir);
	if (tempRoot) {
		await fs.rm(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	}
});

describe("product provider allowlist", () => {
	it("offers exactly the allowlisted model providers plus the web-search OAuth entries", () => {
		const ids = getSelectableOAuthProviders().map(provider => provider.id);

		expect(ids.filter(id => !NON_MODEL_OAUTH_PROVIDER_IDS.includes(id)).sort()).toEqual(
			["anthropic", "openai-codex", "openai-codex-device", "sglang", "vllm"].sort(),
		);
		// Web-search credentials are not model access, so they survive the allowlist.
		expect(ids).toEqual(expect.arrayContaining([...NON_MODEL_OAUTH_PROVIDER_IDS]));
		// Every id offered is either allowlisted or a web-search entry.
		for (const id of ids) {
			expect(SELECTABLE_PROVIDER_IDS.includes(id) || NON_MODEL_OAUTH_PROVIDER_IDS.includes(id)).toBe(true);
		}
		for (const hidden of ["bizrouter", "opengateway", "cursor", "github-copilot", "xai", "minimax-code", "zai"]) {
			expect(ids).not.toContain(hidden);
			expect(hiddenBuiltInProviderIds().has(hidden)).toBe(true);
		}
	});

	it("treats allowlisted ids and user-authored ids as selectable, and other built-ins as hidden", () => {
		for (const id of SELECTABLE_PROVIDER_IDS) expect(isProviderSelectable(id)).toBe(true);
		// An id that is not a built-in provider is the user's own endpoint.
		for (const id of ["my-gpu-box", "lab-cluster", "some-proxy-nobody-ships"]) {
			expect(isProviderSelectable(id)).toBe(true);
		}
		for (const id of ["minimax-code", "cursor", "github-copilot", "opengateway", "kiro", "moonshot"]) {
			expect(isProviderSelectable(id)).toBe(false);
		}
		// Casing and surrounding whitespace do not open a bypass.
		expect(isProviderSelectable("  Cursor ")).toBe(false);
		expect(isProviderSelectable("VLLM")).toBe(true);
		// The web-search OAuth entries are not built-in *model* providers, so the
		// not-a-built-in rule reports them selectable. That is inert rather than a
		// leak: they contribute no models, so no model-selection surface can list
		// them. What matters is that they stay in the `/login` picker.
		for (const id of NON_MODEL_OAUTH_PROVIDER_IDS) {
			expect(hiddenBuiltInProviderIds().has(id)).toBe(false);
			expect(getSelectableOAuthProviders().some(provider => provider.id === id)).toBe(true);
		}
		expect(selectableModels(NON_MODEL_OAUTH_PROVIDER_IDS.map(id => ({ provider: id, id: "search" })))).toHaveLength(
			NON_MODEL_OAUTH_PROVIDER_IDS.length,
		);
	});

	it("filters a model list down to selectable providers, preserving order", () => {
		const models = [
			{ provider: "minimax-code", id: "MiniMax-M3" },
			{ provider: "vllm", id: "qwen3-local" },
			{ provider: "cursor", id: "cursor-fast" },
			{ provider: "my-gpu-box", id: "llama-4" },
			{ provider: "anthropic", id: "claude-opus-5" },
		];
		expect(selectableModels(models).map(model => `${model.provider}/${model.id}`)).toEqual([
			"vllm/qwen3-local",
			"my-gpu-box/llama-4",
			"anthropic/claude-opus-5",
		]);
		expect(selectableModels([])).toEqual([]);
		// The input is not mutated.
		expect(models).toHaveLength(5);
	});

	it("keeps only the self-hosted endpoint presets", () => {
		expect(PROVIDER_PRESETS.map(preset => preset.id)).toEqual(["vllm", "sglang"]);
		expect(PROVIDER_PRESETS.map(preset => preset.providerId)).toEqual(["vllm", "sglang"]);
		expect(PROVIDER_PRESETS.map(preset => preset.apiKeyEnv)).toEqual(["VLLM_API_KEY", "SGLANG_API_KEY"]);
		for (const preset of PROVIDER_PRESETS) {
			expect(preset.parameterized).toBe(true);
			expect(preset.baseUrl).toBeUndefined();
			expect(preset.discovery?.type as string).toBe(preset.providerId);
		}
	});

	it("treats a pasted key as taking precedence over the preset's env-var name", async () => {
		const modelsPath = await tempModelsPath();
		const literal = await addApiCompatibleProvider({
			preset: "sglang",
			baseUrl: "http://127.0.0.1:30000/v1",
			apiKey: "sk-literal-over-env",
			modelsPath,
		});

		expect(literal.credentialSource).toBe("literal");
		expect(literal.redactedApiKey).not.toContain("SGLANG_API_KEY");
		expect((await readProviders(modelsPath)).sglang?.apiKeyEnv).toBeUndefined();
		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			expect(store.listAuthCredentials("sglang")[0]?.credential).toEqual({
				type: "api_key",
				key: "sk-literal-over-env",
			});
		} finally {
			store.close();
		}

		// Without a pasted key the preset's env-var name is still what gets stored.
		const env = await addApiCompatibleProvider({
			preset: "sglang",
			baseUrl: "http://127.0.0.1:30000/v1",
			modelsPath,
			force: true,
		});
		expect(env.credentialSource).toBe("env");
		expect((await readProviders(modelsPath)).sglang?.apiKeyEnv).toBe("SGLANG_API_KEY");
	});

	it("accepts plain http for private-network hosts and still requires https in public", async () => {
		const modelsPath = await tempModelsPath();

		for (const [providerId, host] of [
			["rfc1918-box", "10.0.0.5:8000"],
			["bare-lan-host", "gpu-box:8000"],
		] as const) {
			const result = await addApiCompatibleProvider({
				compatibility: "openai",
				providerId,
				baseUrl: `http://${host}/v1`,
				apiKeyEnv: "LAN_GPU_KEY",
				models: ["local-model"],
				modelsPath,
			});
			expect(result.baseUrl).toBe(`http://${host}/v1`);
		}

		await expect(
			addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "public-host",
				baseUrl: "http://example.com/v1",
				apiKeyEnv: "PUBLIC_KEY",
				models: ["remote-model"],
				modelsPath,
			}),
		).rejects.toThrow("https");
		expect(Object.keys(await readProviders(modelsPath))).toEqual(["rfc1918-box", "bare-lan-host"]);
	});

	it("gives vLLM and SGLang implicit discovery when no models are listed", async () => {
		const modelsPath = await tempModelsPath();

		for (const providerId of ["vllm", "sglang"] as const) {
			const result = await addApiCompatibleProvider({
				compatibility: "openai",
				providerId,
				baseUrl: `http://127.0.0.1:8000/${providerId}/v1`,
				apiKeyEnv: "LOCAL_GPU_KEY",
				modelsPath,
			});
			expect(result.modelIds).toEqual([]);
			const provider = (await readProviders(modelsPath))[providerId];
			expect(provider?.discovery).toEqual({ type: providerId });
			expect(provider?.models).toBeUndefined();
		}

		// Any other provider id still has to name at least one model.
		await expect(
			addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "not-a-gpu-server",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: "OTHER_KEY",
				modelsPath,
			}),
		).rejects.toThrow("At least one model id or model discovery is required.");
	});
});
