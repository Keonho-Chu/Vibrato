import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clampThinkingLevelForModel, Effort, getSupportedEfforts } from "@vib-rato/ai";
import { getAgentDbPath, getAgentDir, setAgentDir } from "@vib-rato/utils";
import { YAML } from "bun";
import { parseSetupArgs } from "../src/cli/setup-cli";
import { ModelRegistry } from "../src/config/model-registry";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/session/auth-storage";
import {
	addApiCompatibleProvider,
	findProviderPreset,
	formatProviderPresetList,
	formatProviderSetupResult,
	parseModelList,
	parseProviderCompatibility,
	redactSecret,
	validateModelApi,
} from "../src/setup/provider-onboarding";

let tempRoot: string | undefined;
const originalAgentDir = getAgentDir();

async function tempModelsPath(): Promise<string> {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vib-provider-onboarding-"));
	// Literal `apiKey` values route through AuthStorage at getAgentDbPath(); without
	// this the tests write real credential rows into the developer's ~/.vib/agent/agent.db.
	setAgentDir(path.join(tempRoot, "agent"));
	return path.join(tempRoot, "models.yml");
}

afterEach(async () => {
	setAgentDir(originalAgentDir);
	if (tempRoot) {
		await fs.rm(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	}
});

describe("provider onboarding setup core", () => {
	it("adds an OpenAI-compatible provider with redacted output", async () => {
		const modelsPath = await tempModelsPath();
		const result = await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "My-OAI",
			baseUrl: "https://api.example.com/v1",
			apiKeyEnv: "MY_OAI_KEY",
			models: ["gpt-example, gpt-second"],
			modelsPath,
		});

		expect(result.providerId).toBe("my-oai");
		expect(result.api).toBe("openai-responses");
		expect(result.modelIds).toEqual(["gpt-example", "gpt-second"]);
		expect(result.credentialSource).toBe("env");
		expect(formatProviderSetupResult(result)).not.toContain("sk-secret-value");

		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers: Record<string, { api: string; apiKey?: string; apiKeyEnv?: string; models: Array<{ id: string }> }>;
		};
		expect(parsed.providers["my-oai"]?.api).toBe("openai-responses");
		expect(parsed.providers["my-oai"]?.apiKey).toBeUndefined();
		expect(parsed.providers["my-oai"]?.apiKeyEnv).toBe("MY_OAI_KEY");
		expect(parsed.providers["my-oai"]?.models.map(model => model.id)).toEqual(["gpt-example", "gpt-second"]);
	});

	it("creates the models.yml parent directory on first provider add", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vib-provider-onboarding-"));
		const modelsPath = path.join(tempRoot, "Users", "example", ".vib", "agent", "models.yml");

		await addApiCompatibleProvider({
			compatibility: "anthropic",
			providerId: "minimax",
			baseUrl: "https://api.minimax.io/anthropic",
			apiKeyEnv: "MINIMAX_APIKEY",
			models: ["MiniMax-M2.7-highspeed"],
			modelsPath,
		});

		expect(await Bun.file(modelsPath).exists()).toBe(true);
		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers: Record<string, { api: string; apiKeyEnv?: string; models: Array<{ id: string }> }>;
		};
		expect(parsed.providers.minimax?.api).toBe("anthropic-messages");
		expect(parsed.providers.minimax?.apiKeyEnv).toBe("MINIMAX_APIKEY");
		expect(parsed.providers.minimax?.models.map(model => model.id)).toEqual(["MiniMax-M2.7-highspeed"]);
	});

	it("accepts first-class Azure OpenAI and Bedrock provider config shapes", async () => {
		const modelsPath = await tempModelsPath();
		await Bun.write(
			modelsPath,
			YAML.stringify({
				providers: {
					"azure-openai": {
						baseUrl: "https://example-resource.openai.azure.com/openai/v1",
						apiKeyEnv: "AZURE_OPENAI_API_KEY",
						api: "azure-openai-responses",
						models: [{ id: "gpt-4.1" }],
					},
					"amazon-bedrock": {
						baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
						api: "bedrock-converse-stream",
						models: [{ id: "us.anthropic.claude-opus-4-6-v1" }],
					},
				},
			}),
		);

		const result = await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "glm-proxy",
			baseUrl: "https://api.z.ai/api/paas/v4",
			apiKeyEnv: "ZAI_API_KEY",
			models: ["glm-4.6"],
			modelsPath,
		});

		expect(result.providerId).toBe("glm-proxy");
	});

	it("adds a vLLM endpoint through the provider preset with discovery instead of pinned models", async () => {
		const modelsPath = await tempModelsPath();
		const result = await addApiCompatibleProvider({
			preset: "vllm",
			baseUrl: "http://127.0.0.1:8000/v1",
			modelsPath,
		});

		expect(result.providerId).toBe("vllm");
		expect(result.api).toBe("openai-completions");
		expect(result.preset).toBe("vllm");
		expect(result.presetName).toBe("vLLM endpoint");
		expect(result.compatibility).toBe("openai");
		expect(result.credentialSource).toBe("env");
		expect(result.modelIds).toEqual([]);
		expect(formatProviderSetupResult(result)).toContain("Models: discovered automatically");

		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers?: Record<
				string,
				{
					api?: string;
					baseUrl?: string;
					auth?: string;
					apiKeyEnv?: string;
					discovery?: unknown;
					models?: Array<{ id: string }>;
				}
			>;
		};
		expect(parsed.providers?.vllm).toEqual({
			baseUrl: "http://127.0.0.1:8000/v1",
			api: "openai-completions",
			auth: "apiKey",
			apiKeyEnv: "VLLM_API_KEY",
			discovery: { type: "vllm" },
		});
		expect(parsed.providers?.vllm?.models).toBeUndefined();
		expect(Object.keys(parsed.providers ?? {})).toEqual(["vllm"]);
	});

	it("adds an SGLang endpoint through the preset alias with a user-supplied https base URL", async () => {
		const modelsPath = await tempModelsPath();
		const result = await addApiCompatibleProvider({
			preset: "sglang-endpoint",
			baseUrl: "https://gpu.example.com/v1",
			modelsPath,
		});

		expect(result.providerId).toBe("sglang");
		expect(result.preset).toBe("sglang");
		expect(result.presetName).toBe("SGLang endpoint");
		expect(result.baseUrl).toBe("https://gpu.example.com/v1");
		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers?: Record<string, { baseUrl?: string; apiKeyEnv?: string; discovery?: { type?: string } }>;
		};
		expect(parsed.providers?.sglang?.baseUrl).toBe("https://gpu.example.com/v1");
		expect(parsed.providers?.sglang?.apiKeyEnv).toBe("SGLANG_API_KEY");
		expect(parsed.providers?.sglang?.discovery?.type).toBe("sglang");
		expect(findProviderPreset("sglang-endpoint")?.id).toBe("sglang");
		expect(formatProviderPresetList()).toContain("sglang");
	});

	it("rejects presets whose provider the allowlist hides and names the remaining ones", async () => {
		const modelsPath = await tempModelsPath();
		for (const removed of ["minimax", "zai", "glm", "alibaba-token-plan", "clinepass", "goat", "litellm"]) {
			expect(findProviderPreset(removed)).toBeUndefined();
			await expect(addApiCompatibleProvider({ preset: removed, modelsPath })).rejects.toThrow(
				`Unknown provider preset '${removed}'`,
			);
		}
		// The failure message points at the presets that survive the allowlist.
		await expect(addApiCompatibleProvider({ preset: "minimax", modelsPath })).rejects.toThrow("vllm");
		expect(await Bun.file(modelsPath).exists()).toBe(false);
	});

	it("loads a generated vLLM provider config into ModelRegistry and keeps it available", async () => {
		const modelsPath = await tempModelsPath();
		await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "vllm",
			baseUrl: "http://10.0.0.5:8000/v1",
			apiKeyEnv: "VLLM_API_KEY",
			models: ["qwen3-a", "qwen3-b"],
			modelsPath,
		});
		const authStorage = await AuthStorage.create(path.join(tempRoot!, "auth.db"));
		authStorage.setRuntimeApiKey("vllm", "test-key");
		try {
			const registry = new ModelRegistry(authStorage, modelsPath);
			const first = registry.find("vllm", "qwen3-a");
			const second = registry.find("vllm", "qwen3-b");
			if (!first || !second) throw new Error("Expected the generated vLLM models to load");

			for (const model of [first, second]) {
				// `vllm` is a built-in descriptor, so its OpenAI-compatible transport
				// wins over the api the generic setup path writes into models.yml.
				expect(model.api).toBe("openai-completions");
				expect(model.baseUrl).toBe("http://10.0.0.5:8000/v1");
				expect(clampThinkingLevelForModel(model, Effort.Medium)).toBe(getSupportedEfforts(model)[0]);
			}
			// The generated rows are the whole catalog: nothing else is configured.
			expect(registry.getAvailable().map(model => `${model.provider}/${model.id}`)).toEqual([
				"vllm/qwen3-a",
				"vllm/qwen3-b",
			]);
		} finally {
			authStorage.close();
		}
	});

	it("rejects modelApi with a key outside the preset models", () => {
		expect(() =>
			validateModelApi({ "unknown-model": "openai-responses" }, ["qwen3.8-max-preview", "glm-5.2"], "test-preset"),
		).toThrow("Provider preset 'test-preset' declares modelApi for unknown model 'unknown-model'.");
	});

	it("rejects modelApi with an invalid API value", () => {
		expect(() =>
			validateModelApi({ "qwen3.8-max-preview": "invalid-api" }, ["qwen3.8-max-preview"], "test-preset"),
		).toThrow(
			"Provider preset 'test-preset' declares invalid modelApi value 'invalid-api' for model 'qwen3.8-max-preview'.",
		);
	});

	it("stores a pasted key in preference to the preset's env-var name", async () => {
		const modelsPath = await tempModelsPath();
		const result = await addApiCompatibleProvider({
			preset: "vllm",
			baseUrl: "http://127.0.0.1:8000/v1",
			apiKey: "sk-pasted-vllm-key",
			modelsPath,
		});

		expect(result.credentialSource).toBe("literal");
		expect(formatProviderSetupResult(result)).not.toContain("VLLM_API_KEY");
		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers?: Record<string, { apiKeyEnv?: string }>;
		};
		// The literal key goes to AuthStorage, so models.yml keeps neither it nor
		// the preset's env-var fallback.
		expect(parsed.providers?.vllm?.apiKeyEnv).toBeUndefined();
		expect(await Bun.file(modelsPath).text()).not.toContain("sk-pasted-vllm-key");
		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			expect(store.listAuthCredentials("vllm")[0]?.credential).toEqual({
				type: "api_key",
				key: "sk-pasted-vllm-key",
			});
		} finally {
			store.close();
		}
	});

	it("adds an Anthropic-compatible provider without deleting unrelated providers", async () => {
		const modelsPath = await tempModelsPath();
		await Bun.write(
			modelsPath,
			YAML.stringify({
				providers: {
					existing: {
						baseUrl: "https://old.example/v1",
						apiKey: "old",
						api: "openai-responses",
						models: [{ id: "old-model" }],
					},
				},
			}),
		);

		await addApiCompatibleProvider({
			compatibility: "anthropic",
			providerId: "claude-proxy",
			baseUrl: "http://127.0.0.1:4000",
			apiKey: "anthropic-secret",
			models: ["claude-custom"],
			modelsPath,
		});

		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers: Record<string, { api: string; models: Array<{ id: string }> }>;
		};
		expect(parsed.providers.existing?.api).toBe("openai-responses");
		expect(parsed.providers["claude-proxy"]?.api).toBe("anthropic-messages");
		expect(parsed.providers["claude-proxy"]?.models.map(model => model.id)).toEqual(["claude-custom"]);
	});

	it("stores literal keys in AuthStorage instead of models.yml", async () => {
		const modelsPath = await tempModelsPath();
		await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "literal-key-provider",
			baseUrl: "https://api.example.com/v1",
			apiKey: "literal-secret",
			models: ["example-model"],
			modelsPath,
		});
		const text = await Bun.file(modelsPath).text();
		expect(text).not.toContain("literal-secret");
		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			expect(store.listAuthCredentials("literal-key-provider")[0]?.credential).toEqual({
				type: "api_key",
				key: "literal-secret",
			});
		} finally {
			store.close();
		}
	});

	it("stores literal keys in the canonical agent database with a custom models path", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vib-provider-onboarding-"));
		setAgentDir(path.join(tempRoot, "agent"));
		const modelsPath = path.join(tempRoot, "custom", "models.yml");
		await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "custom-path-provider",
			baseUrl: "https://api.example.com/v1",
			apiKey: "custom-path-secret",
			models: ["example-model"],
			modelsPath,
		});

		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			expect(store.listAuthCredentials("custom-path-provider")[0]?.credential).toEqual({
				type: "api_key",
				key: "custom-path-secret",
			});
		} finally {
			store.close();
		}
		expect(await Bun.file(path.join(path.dirname(modelsPath), "agent.db")).exists()).toBe(false);
	});

	it("rejects remote plaintext HTTP and existing providers unless forced", async () => {
		const modelsPath = await tempModelsPath();
		await expect(
			addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "remote-http",
				baseUrl: "http://api.example.test/v1",
				apiKeyEnv: "REMOTE_HTTP_KEY",
				models: ["gpt-example"],
				modelsPath,
			}),
		).rejects.toThrow("https");

		await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "local-http",
			baseUrl: "http://[::1]:4000/v1",
			apiKeyEnv: "LOCAL_HTTP_KEY",
			models: ["gpt-example"],
			modelsPath,
		});
		await expect(
			addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "local-http",
				baseUrl: "http://127.0.0.1:5000/v1",
				apiKeyEnv: "LOCAL_HTTP_KEY",
				models: ["gpt-updated"],
				modelsPath,
			}),
		).rejects.toThrow("already exists");
		await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "local-http",
			baseUrl: "http://127.0.0.1:5000/v1",
			apiKeyEnv: "LOCAL_HTTP_KEY",
			models: ["gpt-updated"],
			modelsPath,
			force: true,
		});
		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers: Record<string, { baseUrl: string; apiKeyEnv: string; models: Array<{ id: string }> }>;
		};
		expect(parsed.providers["local-http"]?.baseUrl).toBe("http://127.0.0.1:5000/v1");
		expect(parsed.providers["local-http"]?.apiKeyEnv).toBe("LOCAL_HTTP_KEY");
		expect(parsed.providers["local-http"]?.models.map(model => model.id)).toEqual(["gpt-updated"]);
	});

	it("rejects conflicting compatibility when a provider preset is used", async () => {
		await expect(
			addApiCompatibleProvider({
				preset: "vllm",
				compatibility: "anthropic",
				baseUrl: "http://127.0.0.1:8000/v1",
				modelsPath: await tempModelsPath(),
			}),
		).rejects.toThrow("vllm' is openai-compatible");
	});

	it("requires --base-url for parameterized endpoint presets", async () => {
		const modelsPath = await tempModelsPath();
		await expect(
			addApiCompatibleProvider({
				preset: "vllm",
				modelsPath,
			}),
		).rejects.toThrow("requires --base-url");
		await expect(
			addApiCompatibleProvider({
				preset: "sglang",
				modelsPath,
			}),
		).rejects.toThrow("requires --base-url");
		expect(await Bun.file(modelsPath).exists()).toBe(false);
	});

	it("rejects provider preset attempts to pin models on parameterized endpoint presets", async () => {
		const modelsPath = await tempModelsPath();
		await expect(
			addApiCompatibleProvider({
				preset: "vllm",
				baseUrl: "http://127.0.0.1:8000/v1",
				models: ["gpt-example"],
				modelsPath,
			}),
		).rejects.toThrow("discovers models automatically");
		expect(await Bun.file(modelsPath).exists()).toBe(false);
	});

	it("allows overriding the API key env on parameterized endpoint presets", async () => {
		const modelsPath = await tempModelsPath();
		const result = await addApiCompatibleProvider({
			preset: "vllm",
			baseUrl: "http://127.0.0.1:8000/v1",
			apiKeyEnv: "MY_GPU_BOX_KEY",
			modelsPath,
		});

		expect(result.credentialSource).toBe("env");
		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers: Record<string, { apiKeyEnv: string }>;
		};
		expect(parsed.providers.vllm?.apiKeyEnv).toBe("MY_GPU_BOX_KEY");
	});

	it("resolves parameterized endpoint preset aliases", () => {
		expect(findProviderPreset("vllm-endpoint")?.id).toBe("vllm");
		expect(findProviderPreset("sglang-endpoint")?.id).toBe("sglang");
		expect(formatProviderPresetList()).toContain("vllm");
		expect(formatProviderPresetList()).toContain("sglang");
	});

	it("keeps generic OpenAI-compatible custom provider setup available for custom values", async () => {
		const modelsPath = await tempModelsPath();

		const result = await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "custom-minimax",
			baseUrl: "https://example.invalid/v1",
			apiKeyEnv: "CUSTOM_KEY",
			models: ["custom-model"],
			modelsPath,
		});

		expect(result.providerId).toBe("custom-minimax");
		expect(result.modelIds).toEqual(["custom-model"]);
		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers: Record<string, { baseUrl: string; apiKeyEnv?: string; models: Array<{ id: string }> }>;
		};
		expect(parsed.providers["custom-minimax"]?.baseUrl).toBe("https://example.invalid/v1");
		expect(parsed.providers["custom-minimax"]?.apiKeyEnv).toBe("CUSTOM_KEY");
		expect(parsed.providers["custom-minimax"]?.models.map(model => model.id)).toEqual(["custom-model"]);
	});

	it("validates compatibility, models, urls, and redacts short secrets", () => {
		expect(parseProviderCompatibility("oai")).toBe("openai");
		expect(parseProviderCompatibility("claude")).toBe("anthropic");
		expect(findProviderPreset("vllm-endpoint")?.id).toBe("vllm");
		expect(findProviderPreset("sglang")?.id).toBe("sglang");
		expect(formatProviderPresetList()).toContain("vllm");
		expect(formatProviderPresetList()).toContain("sglang");
		expect(parseModelList(["a,b", "a", " c "])).toEqual(["a", "b", "c"]);
		expect(redactSecret("short")).toBe("***");
		expect(redactSecret("sk-1234567890")).toBe("sk-1…7890");
	});

	it("parses setup command provider preset option", () => {
		const parsed = parseSetupArgs(["setup", "provider", "--preset", "vllm"]);

		expect(parsed?.component).toBe("provider");
		expect(parsed?.flags.preset).toBe("vllm");
	});

	it("parses explicit setup command provider options", () => {
		const parsed = parseSetupArgs([
			"setup",
			"provider",
			"--compat",
			"openai",
			"--provider",
			"local-openai",
			"--base-url",
			"https://api.example.test/v1",
			"--api-key-env",
			"VIB_TEST_PROVIDER_KEY",
			"--model",
			"gpt-one",
			"--models",
			"gpt-two,gpt-three",
		]);

		expect(parsed?.component).toBe("provider");
		expect(parsed?.flags.compat).toBe("openai");
		expect(parsed?.flags.provider).toBe("local-openai");
		expect(parsed?.flags.apiKeyEnv).toBe("VIB_TEST_PROVIDER_KEY");
		expect(parsed?.flags.model).toEqual(["gpt-one", "gpt-two,gpt-three"]);
	});

	it("rejects raw API keys in setup provider arguments", () => {
		const exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation((code?: string | number | null | undefined): never => {
				throw new Error(`exit ${code}`);
			});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			expect(() =>
				parseSetupArgs([
					"setup",
					"provider",
					"--compat",
					"openai",
					"--provider",
					"raw-key",
					"--base-url",
					"https://api.example.test/v1",
					"--api-key",
					"sk-secret",
					"--model",
					"gpt",
				]),
			).toThrow("exit 1");
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Provider setup rejects raw --api-key values"));
		} finally {
			errorSpy.mockRestore();
			exitSpy.mockRestore();
		}
	});
});
