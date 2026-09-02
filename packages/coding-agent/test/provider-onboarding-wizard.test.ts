import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@vib-rato/ai";
import { ModelRegistry } from "@vib-rato/coding-agent/config/model-registry";
import {
	CustomProviderWizardComponent,
	type CustomProviderWizardSubmit,
} from "@vib-rato/coding-agent/modes/components/custom-provider-wizard";
import {
	type ProviderOnboardingAction,
	ProviderOnboardingSelectorComponent,
} from "@vib-rato/coding-agent/modes/components/provider-onboarding-selector";
import { SelectorController } from "@vib-rato/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@vib-rato/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@vib-rato/coding-agent/modes/types";
import { getAgentDir, setAgentDir } from "@vib-rato/utils";

const originalAgentDir = getAgentDir();
let tempAgentDir: string | undefined;

beforeAll(async () => {
	await initTheme(false);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	if (tempAgentDir) {
		await fs.rm(tempAgentDir, { recursive: true, force: true });
		tempAgentDir = undefined;
	}
});

function visibleText(component: { render(width: number): string[] }): string {
	return Bun.stripANSI(component.render(160).join("\n"));
}

function typeText(component: { handleInput(input: string): void }, text: string): void {
	for (const char of text) component.handleInput(char);
}

function clearInput(component: { handleInput(input: string): void }, length: number): void {
	for (let i = 0; i < length; i++) component.handleInput("\x7f");
}

function driveEnvWizard(
	component: CustomProviderWizardComponent,
	options?: { providerId?: string; model?: string },
): void {
	component.handleInput("\n");
	typeText(component, options?.providerId ?? "custom-openai");
	component.handleInput("\n");
	typeText(component, "https://api.example.com/v1");
	component.handleInput("\n");
	component.handleInput("\n");
	typeText(component, "CUSTOM_PROVIDER_KEY");
	component.handleInput("\n");
	typeText(component, options?.model ?? "custom-model");
	component.handleInput("\n");
}

describe("provider onboarding wizard", () => {
	it("shows the endpoint options first, ahead of the custom provider and OAuth entries", () => {
		const actions: ProviderOnboardingAction[] = [];
		const selector = new ProviderOnboardingSelectorComponent(
			action => actions.push(action),
			() => undefined,
		);

		const rendered = visibleText(selector);
		expect(rendered.indexOf("Connect a vLLM endpoint")).toBeLessThan(rendered.indexOf("Connect an SGLang endpoint"));
		expect(rendered.indexOf("Connect an SGLang endpoint")).toBeLessThan(rendered.indexOf("Add custom provider"));
		expect(rendered.indexOf("Add custom provider")).toBeLessThan(rendered.indexOf("Login with OAuth/subscription"));
		expect(rendered).toContain("Add API-compatible provider");

		selector.handleInput("\n");
		expect(actions).toEqual(["vllm-endpoint"]);

		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(actions).toEqual(["vllm-endpoint", "sglang-endpoint"]);

		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(actions).toEqual(["vllm-endpoint", "sglang-endpoint", "custom-provider-wizard"]);
	});

	it("collapses the vLLM preset wizard to base URL, key, confirm", () => {
		const submissions: CustomProviderWizardSubmit[] = [];
		const wizard = new CustomProviderWizardComponent(
			input => submissions.push(input),
			() => undefined,
			() => undefined,
			{ preset: "vllm" },
		);

		// Step 1 is the server URL: there is no compatibility or provider-id step.
		expect(visibleText(wizard)).toContain("Connect a vLLM endpoint");
		expect(visibleText(wizard)).toContain("Step 1: Server URL");
		// The field is pre-filled with the loopback default; clear it before typing.
		clearInput(wizard, "http://127.0.0.1:8000/v1".length);
		typeText(wizard, "http://10.0.0.5:8000/v1");
		wizard.handleInput("\n");

		expect(visibleText(wizard)).toContain("Step 2: API key");
		typeText(wizard, "sk-vllm-secret");
		expect(visibleText(wizard)).not.toContain("sk-vllm-secret");
		wizard.handleInput("\n");

		const confirm = visibleText(wizard);
		expect(confirm).toContain("Confirm custom provider");
		expect(confirm).toContain("Provider: vllm");
		expect(confirm).toContain("Base URL: http://10.0.0.5:8000/v1");
		expect(confirm).toContain("Models: discovered from the server");
		wizard.handleInput("\n");

		expect(submissions).toEqual([
			{ preset: "vllm", baseUrl: "http://10.0.0.5:8000/v1", apiKey: "sk-vllm-secret", force: false },
		]);
	});

	it("stores the vllm-local token when the vLLM key is left empty", () => {
		const submissions: CustomProviderWizardSubmit[] = [];
		const wizard = new CustomProviderWizardComponent(
			input => submissions.push(input),
			() => undefined,
			() => undefined,
			{ preset: "vllm" },
		);

		wizard.handleInput("\n"); // accept the default server URL
		expect(visibleText(wizard)).toContain("Leave empty for an unauthenticated local server.");
		wizard.handleInput("\n"); // empty key

		expect(visibleText(wizard)).toContain("Credential: none (unauthenticated local server)");
		wizard.handleInput("\n");

		expect(submissions).toEqual([
			{ preset: "vllm", baseUrl: "http://127.0.0.1:8000/v1", apiKey: "vllm-local", force: false },
		]);
	});

	it("requires a key for the SGLang preset, which has no local fallback token", () => {
		const submissions: CustomProviderWizardSubmit[] = [];
		const wizard = new CustomProviderWizardComponent(
			input => submissions.push(input),
			() => undefined,
			() => undefined,
			{ preset: "sglang" },
		);

		expect(visibleText(wizard)).toContain("Connect an SGLang endpoint");
		wizard.handleInput("\n"); // accept the default server URL
		expect(visibleText(wizard)).not.toContain("Leave empty for an unauthenticated local server.");
		wizard.handleInput("\n"); // empty key is refused, so the step stays put
		expect(visibleText(wizard)).toContain("Step 2: API key");

		typeText(wizard, "sk-sglang-secret");
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		expect(submissions).toEqual([
			{ preset: "sglang", baseUrl: "http://127.0.0.1:30000/v1", apiKey: "sk-sglang-secret", force: false },
		]);
	});

	it("emits the expected addApiCompatibleProvider input", () => {
		const submissions: unknown[] = [];
		const wizard = new CustomProviderWizardComponent(
			input => submissions.push(input),
			() => undefined,
		);

		driveEnvWizard(wizard);
		wizard.handleInput("\n");

		expect(submissions).toEqual([
			{
				compatibility: "openai",
				providerId: "custom-openai",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: "CUSTOM_PROVIDER_KEY",
				apiKey: undefined,
				models: ["custom-model"],
				force: false,
			},
		]);
	});

	it("ignores duplicate Enter while a submit is pending and permits retry after rejection", async () => {
		const submissions: CustomProviderWizardSubmit[] = [];
		const deferred = Promise.withResolvers<void>();
		const wizard = new CustomProviderWizardComponent(
			input => {
				submissions.push(input);
				return submissions.length === 1 ? deferred.promise : undefined;
			},
			() => undefined,
		);

		driveEnvWizard(wizard);
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		expect(submissions).toHaveLength(1);

		deferred.reject(new Error("submit failed"));
		await deferred.promise.catch(() => undefined);
		wizard.handleInput("\n");
		expect(submissions).toHaveLength(2);
	});

	it("preserves literal credentials for force confirmation and clears them on completion", () => {
		const submissions: CustomProviderWizardSubmit[] = [];
		const wizard = new CustomProviderWizardComponent(
			input => submissions.push(input),
			() => undefined,
		);

		wizard.handleInput("\n");
		typeText(wizard, "literal-provider");
		wizard.handleInput("\n");
		typeText(wizard, "https://api.example.com/v1");
		wizard.handleInput("\n");
		wizard.handleInput("\x1b[B");
		wizard.handleInput("\n");
		typeText(wizard, "literal-secret");
		expect(visibleText(wizard)).not.toContain("literal-secret");
		wizard.handleInput("\n");
		typeText(wizard, "literal-model");
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		wizard.setSubmitError("Provider setup failed: Provider 'literal-provider' already exists.");
		wizard.handleInput("\x1b[B");
		wizard.handleInput("\n");

		expect(submissions).toEqual([
			expect.objectContaining({ apiKey: "literal-secret", apiKeyEnv: undefined, force: false }),
			expect.objectContaining({ apiKey: "literal-secret", apiKeyEnv: undefined, force: true }),
		]);

		wizard.complete();
		wizard.handleInput("\n");
		expect(submissions.at(-1)).toEqual(expect.objectContaining({ apiKey: "", force: true }));
	});

	it("requires explicit force confirmation before overwrite", () => {
		const submissions: unknown[] = [];
		const wizard = new CustomProviderWizardComponent(
			input => submissions.push(input),
			() => undefined,
		);

		driveEnvWizard(wizard);
		wizard.handleInput("\n");
		wizard.setSubmitError(
			"Provider setup failed: Provider 'custom-openai' already exists. Use --force to replace it.",
		);
		wizard.handleInput("\x1b[B");
		wizard.handleInput("\n");

		expect(submissions).toEqual([
			expect.objectContaining({ force: false }),
			expect.objectContaining({ force: true }),
		]);
	});

	it("refreshes offline after success and exposes the provider in model selector data without restart", async () => {
		tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "vib-provider-wizard-"));
		setAgentDir(tempAgentDir);
		const store = await SqliteAuthCredentialStore.open(path.join(tempAgentDir, "agent.db"));
		try {
			const authStorage = new AuthStorage(store);
			const registry = new ModelRegistry(authStorage, path.join(tempAgentDir, "models.yml"));
			const refreshModes: (string | undefined)[] = [];
			const originalRefresh = registry.refresh.bind(registry);
			registry.refresh = async mode => {
				refreshModes.push(mode);
				await originalRefresh(mode);
			};
			let configChanged = false;
			const ctx = createControllerContext(registry, () => {
				configChanged = true;
			});
			const successStatus = [
				"Provider 'live-provider' configured as openai-compatible.",
				"Models: live-model",
				"Base URL: https://api.example.com/v1",
				"API key: CUST…_KEY (environment variable)",
				`Config: ${path.join(tempAgentDir!, "models.yml")}`,
			].join("\n");
			const { promise: completion, resolve: resolveCompletion } = Promise.withResolvers<void>();
			ctx.showStatus = message => {
				ctx.statuses.push(message);
				if (message === successStatus) {
					resolveCompletion();
				}
			};
			const controller = new SelectorController(ctx);

			controller.showCustomProviderWizard();
			const wizard = ctx.ui.focused as CustomProviderWizardComponent;
			driveEnvWizard(wizard, { providerId: "live-provider", model: "live-model" });
			wizard.handleInput("\n");
			await completion;

			expect(refreshModes).toEqual(["offline"]);
			expect(configChanged).toBe(true);
			expect(registry.find("live-provider", "live-model")).toBeDefined();
			expect(ctx.statuses).toEqual([successStatus]);
		} finally {
			store.close();
		}
	});

	it("keeps OAuth and API guide onboarding actions routed", () => {
		const ctx = createControllerContext({ refresh: async () => undefined } as unknown as ModelRegistry);
		const controller = new SelectorController(ctx);
		const showOAuth = mock(() => undefined);
		controller.showOAuthSelector = showOAuth as unknown as SelectorController["showOAuthSelector"];

		controller.showProviderOnboarding();
		let selector = ctx.ui.focused as ProviderOnboardingSelectorComponent;
		// vLLM, SGLang, Add custom provider, then Login with OAuth/subscription.
		for (let i = 0; i < 3; i++) selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(showOAuth).toHaveBeenCalledWith("login");

		controller.showProviderOnboarding();
		selector = ctx.ui.focused as ProviderOnboardingSelectorComponent;
		for (let i = 0; i < 4; i++) selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(ctx.statuses.join("\n")).toContain("Custom API-compatible provider setup:");
	});
});

function createControllerContext(
	modelRegistry: Pick<ModelRegistry, "refresh">,
	notifyConfigChanged?: () => void,
): InteractiveModeContext & {
	statuses: string[];
	ui: { focused?: unknown; requestRender: () => void; setFocus: (component: unknown) => void };
} {
	const children: unknown[] = [];
	const editor = {};
	const statuses: string[] = [];
	return {
		ui: {
			focused: undefined as unknown,
			requestRender: () => undefined,
			setFocus(component: unknown) {
				this.focused = component;
			},
		},
		editor,
		editorContainer: {
			clear: () => {
				children.length = 0;
			},
			detachChild: () => {},
			addChild: (child: unknown) => {
				children.push(child);
			},
		},
		session: { modelRegistry },
		sessionManager: { getCwd: () => process.cwd() },
		settings: {},
		showStatus: (message: string) => statuses.push(message),
		showError: (message: string) => statuses.push(message),
		showWarning: (message: string) => statuses.push(message),
		notifyConfigChanged,
		statuses,
	} as unknown as InteractiveModeContext & {
		statuses: string[];
		ui: { focused?: unknown; requestRender: () => void; setFocus: (component: unknown) => void };
	};
}
