import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getEnvApiKey } from "@vib-rato/ai";
import type { ModelRegistry } from "@vib-rato/coding-agent/config/model-registry";
import {
	findProvidersWithEmptyApiKeyEnv,
	ModelRegistry as ModelRegistryImpl,
} from "@vib-rato/coding-agent/config/model-registry";
import { Settings } from "@vib-rato/coding-agent/config/settings";
import { ModelSelectorComponent } from "@vib-rato/coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@vib-rato/coding-agent/modes/theme/theme";
import { AuthStorage } from "@vib-rato/coding-agent/session/auth-storage";
import type { TUI } from "@vib-rato/tui";
import { Snowflake } from "@vib-rato/utils";

const HIDDEN_ENV_NAME = "VIB_TEST_HIDDEN_GATEWAY_KEY";

function normalizeRenderedText(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

let testTheme = await getThemeByName("lig-blue");

function installTestTheme(): void {
	if (!testTheme) throw new Error("Failed to load the theme for the hidden-provider selector test");
	setThemeInstance(testTheme);
}

function gatewayProviderYaml(envName: string): string {
	return [
		"providers:",
		"  vllm:",
		"    baseUrl: http://127.0.0.1:8788/v1",
		`    apiKeyEnv: ${envName}`,
		"    api: openai-completions",
		"    auth: apiKey",
		"    models:",
		"      - id: qwen",
		"        name: Qwen",
		"        contextWindow: 128000",
		"        maxTokens: 8192",
	].join("\n");
}

describe("empty apiKeyEnv is recorded as the cause of a hidden provider", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;
	let previousEnvValue: string | undefined;
	let previousVllmKey: string | undefined;

	beforeAll(async () => {
		testTheme = await getThemeByName("lig-blue");
	});

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `vib-test-hidden-provider-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		previousEnvValue = Bun.env[HIDDEN_ENV_NAME];
		delete Bun.env[HIDDEN_ENV_NAME];
		// `vllm` has a built-in VLLM_API_KEY fallback, which would authenticate the
		// fixture provider and make the hidden-provider cases vacuous on a machine
		// that happens to have it set.
		previousVllmKey = Bun.env.VLLM_API_KEY;
		delete Bun.env.VLLM_API_KEY;
	});

	afterEach(() => {
		if (previousVllmKey === undefined) delete Bun.env.VLLM_API_KEY;
		else Bun.env.VLLM_API_KEY = previousVllmKey;
		if (previousEnvValue === undefined) delete Bun.env[HIDDEN_ENV_NAME];
		else Bun.env[HIDDEN_ENV_NAME] = previousEnvValue;
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("names the provider and the variable, and nothing else", () => {
		const hidden = findProvidersWithEmptyApiKeyEnv({
			providers: {
				vllm: { baseUrl: "http://127.0.0.1:8788/v1", apiKeyEnv: HIDDEN_ENV_NAME },
			},
		});

		expect(hidden).toEqual([{ provider: "vllm", envName: HIDDEN_ENV_NAME }]);
	});

	test("says nothing about providers that do not need the variable", () => {
		const hidden = findProvidersWithEmptyApiKeyEnv({
			providers: {
				keyless: { baseUrl: "http://127.0.0.1:1234/v1", apiKeyEnv: HIDDEN_ENV_NAME, auth: "none" },
				literal: { baseUrl: "http://127.0.0.1:1235/v1", apiKey: "sk-literal", apiKeyEnv: HIDDEN_ENV_NAME },
				subscription: { baseUrl: "http://127.0.0.1:1236/v1", apiKeyEnv: HIDDEN_ENV_NAME, auth: "oauth" },
				nokey: { baseUrl: "http://127.0.0.1:1237/v1" },
			},
		});

		expect(hidden).toEqual([]);
	});

	test("says nothing once the variable holds a value", () => {
		Bun.env[HIDDEN_ENV_NAME] = "vug_live_value";

		const hidden = findProvidersWithEmptyApiKeyEnv({
			providers: { vllm: { baseUrl: "http://127.0.0.1:8788/v1", apiKeyEnv: HIDDEN_ENV_NAME } },
		});

		expect(hidden).toEqual([]);
	});

	test("says nothing about a bundled provider that its own environment variable still authenticates", () => {
		// `models.yml` is not the whole credential story: `openai` reads
		// OPENAI_API_KEY on its own, so an empty `apiKeyEnv` beside it hides
		// nothing and naming the provider would point at models that are listed.
		const previousOpenAiKey = Bun.env.OPENAI_API_KEY;
		Bun.env.OPENAI_API_KEY = "sk-test-builtin-fallback";
		try {
			expect(getEnvApiKey("openai")).toBeDefined();

			const hidden = findProvidersWithEmptyApiKeyEnv({
				providers: { openai: { apiKeyEnv: HIDDEN_ENV_NAME } },
			});

			expect(hidden).toEqual([]);
		} finally {
			if (previousOpenAiKey === undefined) delete Bun.env.OPENAI_API_KEY;
			else Bun.env.OPENAI_API_KEY = previousOpenAiKey;
		}
	});

	test("the registry and the config-only helper agree about a provider its own variable authenticates", () => {
		const previousOpenAiKey = Bun.env.OPENAI_API_KEY;
		Bun.env.OPENAI_API_KEY = "sk-test-builtin-fallback";
		fs.writeFileSync(modelsPath, ["providers:", "  openai:", `    apiKeyEnv: ${HIDDEN_ENV_NAME}`].join("\n"));
		try {
			const registry = new ModelRegistryImpl(authStorage, modelsPath);

			// The provider is not hidden at all: its models are in the list.
			expect(registry.getAvailable().some(model => model.provider === "openai")).toBe(true);
			expect(registry.getProvidersHiddenByMissingApiKeyEnv()).toEqual([]);
			// The config-only helper `vib local-provider status` uses must not
			// disagree with the registry and name a provider the user can see.
			expect(findProvidersWithEmptyApiKeyEnv({ providers: { openai: { apiKeyEnv: HIDDEN_ENV_NAME } } })).toEqual([]);
		} finally {
			if (previousOpenAiKey === undefined) delete Bun.env.OPENAI_API_KEY;
			else Bun.env.OPENAI_API_KEY = previousOpenAiKey;
		}
	});

	test("treats a variable set to whitespace as unset", () => {
		Bun.env[HIDDEN_ENV_NAME] = "   ";

		const hidden = findProvidersWithEmptyApiKeyEnv({
			providers: { vllm: { baseUrl: "http://127.0.0.1:8788/v1", apiKeyEnv: HIDDEN_ENV_NAME } },
		});

		expect(hidden).toEqual([{ provider: "vllm", envName: HIDDEN_ENV_NAME }]);
	});

	test("the registry keeps excluding the provider and reports why", () => {
		fs.writeFileSync(modelsPath, gatewayProviderYaml(HIDDEN_ENV_NAME));

		const registry = new ModelRegistryImpl(authStorage, modelsPath);

		// The exclusion itself is unchanged: this is a cause report, not a policy.
		expect(registry.getAvailable().filter(model => model.provider === "vllm")).toEqual([]);
		expect(registry.getProvidersHiddenByMissingApiKeyEnv()).toEqual([{ provider: "vllm", envName: HIDDEN_ENV_NAME }]);
		// Repeated reads report the same one entry rather than accumulating.
		expect(registry.getProvidersHiddenByMissingApiKeyEnv()).toEqual([{ provider: "vllm", envName: HIDDEN_ENV_NAME }]);
	});

	test("the registry stays quiet when the variable holds a value", () => {
		Bun.env[HIDDEN_ENV_NAME] = "vug_live_value";
		fs.writeFileSync(modelsPath, gatewayProviderYaml(HIDDEN_ENV_NAME));

		const registry = new ModelRegistryImpl(authStorage, modelsPath);

		expect(registry.getAvailable().some(model => model.provider === "vllm")).toBe(true);
		expect(registry.getProvidersHiddenByMissingApiKeyEnv()).toEqual([]);
	});

	async function createSelectorWithHiddenProvider(): Promise<ModelSelectorComponent> {
		installTestTheme();
		const modelRegistry = {
			refresh: async () => {},
			refreshProvider: async () => {},
			getError: () => undefined,
			getAvailable: () => [],
			getAll: () => [],
			hasConfiguredProviderAuth: () => false,
			getDiscoverableProviders: () => ["vllm"],
			getCanonicalModels: () => [],
			getCanonicalModelSelections: () => [],
			resolveCanonicalModel: () => undefined,
			getProviderDiscoveryState: () => undefined,
			getProvidersHiddenByMissingApiKeyEnv: () => [{ provider: "vllm", envName: HIDDEN_ENV_NAME }],
		} as unknown as ModelRegistry;
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const selector = new ModelSelectorComponent(
			ui,
			undefined,
			Settings.isolated({}),
			modelRegistry,
			[],
			() => {},
			() => {},
		);
		await Bun.sleep(0);
		installTestTheme();
		return selector;
	}

	test("the model selector explains the empty provider tab with the variable name", async () => {
		const selector = await createSelectorWithHiddenProvider();
		// Step right past the static tabs onto the vllm provider tab.
		selector.handleInput("\x1b[C");
		selector.handleInput("\x1b[C");
		await Bun.sleep(0);

		const rendered = normalizeRenderedText(selector.render(200).join("\n"));

		expect(rendered).toContain(`${HIDDEN_ENV_NAME} is not set, so this provider's models are hidden`);
		expect(rendered).not.toContain("No matching models");
	});

	test("the model selector names the hidden provider on the combined tab too", async () => {
		const selector = await createSelectorWithHiddenProvider();
		// Leave the preset landing for the model list, then come back to ALL.
		selector.handleInput("\x1b[C");
		selector.handleInput("\x1b[C");
		selector.handleInput("\x1b[D");
		selector.handleInput("\x1b[D");
		await Bun.sleep(0);

		const rendered = normalizeRenderedText(selector.render(200).join("\n"));

		expect(rendered).toContain(`Hidden by an unset key: vllm needs ${HIDDEN_ENV_NAME}`);
	});
});
