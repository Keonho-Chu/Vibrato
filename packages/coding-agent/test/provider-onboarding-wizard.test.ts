import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@vib-rato/ai";
import { ModelRegistry } from "@vib-rato/coding-agent/config/model-registry";
import {
	CustomProviderWizardComponent,
	type CustomProviderWizardSubmit,
} from "@vib-rato/coding-agent/modes/components/custom-provider-wizard";
import { LocalEndpointConnectComponent } from "@vib-rato/coding-agent/modes/components/local-endpoint-connect";
import { LocalModelPickerComponent } from "@vib-rato/coding-agent/modes/components/local-model-picker";
import {
	type ProviderOnboardingAction,
	ProviderOnboardingSelectorComponent,
} from "@vib-rato/coding-agent/modes/components/provider-onboarding-selector";
import { SelectorController } from "@vib-rato/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@vib-rato/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@vib-rato/coding-agent/modes/types";
import * as localEndpoint from "@vib-rato/coding-agent/setup/local-endpoint";
import type { ProviderSetupResult } from "@vib-rato/coding-agent/setup/provider-onboarding";
import { getAgentDir, setAgentDir } from "@vib-rato/utils";

const originalAgentDir = getAgentDir();
let tempAgentDir: string | undefined;

const REAL_LOCAL_ENDPOINT = { ...localEndpoint };

// The connect screen reaches the network through these three; only the URL
// normalizer stays real, so the tests still assert the shorthand a user types.
let discoverStub: typeof localEndpoint.discoverLoopbackEndpoints = async () => [];
let probeStub: typeof localEndpoint.probeLocalEndpoint = async () => ({ status: "unreachable", detail: "no stub" });
let registerStub: typeof localEndpoint.registerLocalEndpoint = async () => {
	throw new Error("registerLocalEndpoint is not stubbed");
};

beforeAll(async () => {
	await initTheme(false);
	mock.module("../src/setup/local-endpoint", () => ({
		...REAL_LOCAL_ENDPOINT,
		discoverLoopbackEndpoints: (...args: Parameters<typeof localEndpoint.discoverLoopbackEndpoints>) =>
			discoverStub(...args),
		probeLocalEndpoint: (...args: Parameters<typeof localEndpoint.probeLocalEndpoint>) => probeStub(...args),
		registerLocalEndpoint: (...args: Parameters<typeof localEndpoint.registerLocalEndpoint>) => registerStub(...args),
	}));
});

afterAll(() => {
	mock.module("../src/setup/local-endpoint", () => REAL_LOCAL_ENDPOINT);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	discoverStub = async () => [];
	probeStub = async () => ({ status: "unreachable", detail: "no stub" });
	registerStub = async () => {
		throw new Error("registerLocalEndpoint is not stubbed");
	};
	if (tempAgentDir) {
		await fs.rm(tempAgentDir, { recursive: true, force: true });
		tempAgentDir = undefined;
	}
});

/** Let the stubbed probe/registration promises settle. */
async function flush(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0));
}

function visibleText(component: { render(width: number): string[] }): string {
	return Bun.stripANSI(component.render(160).join("\n"));
}

function typeText(component: { handleInput(input: string): void }, text: string): void {
	for (const char of text) component.handleInput(char);
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
	it("shows the local endpoint first, then the Codex and Claude logins", () => {
		const actions: ProviderOnboardingAction[] = [];
		const selector = new ProviderOnboardingSelectorComponent(
			action => actions.push(action),
			() => undefined,
		);

		const rendered = visibleText(selector);
		expect(rendered.indexOf("Connect a local LLM endpoint")).toBeLessThan(
			rendered.indexOf("Login with OpenAI Codex"),
		);
		expect(rendered.indexOf("Login with OpenAI Codex")).toBeLessThan(rendered.indexOf("Login with Claude"));
		expect(rendered.indexOf("Login with Claude")).toBeLessThan(rendered.indexOf("Login with OAuth/subscription"));
		expect(rendered.indexOf("Login with OAuth/subscription")).toBeLessThan(rendered.indexOf("Add custom provider"));
		expect(rendered.indexOf("Add custom provider")).toBeLessThan(rendered.indexOf("Import existing credentials"));
		expect(rendered.indexOf("Import existing credentials")).toBeLessThan(
			rendered.indexOf("Add API-compatible provider"),
		);
		// The named self-hosted presets stay reachable by command, not by menu entry.
		expect(rendered).not.toContain("Connect a vLLM endpoint");
		expect(rendered).not.toContain("Connect an SGLang endpoint");

		// The endpoint is the main path; the subscription logins sit under a muted
		// heading below it so they read as secondary, not as peers.
		expect(rendered.indexOf("Connect a local LLM endpoint")).toBeLessThan(rendered.indexOf("Other ways to sign in"));
		expect(rendered.indexOf("Other ways to sign in")).toBeLessThan(rendered.indexOf("Login with OpenAI Codex"));
		expect(rendered.indexOf("Login with OAuth/subscription")).toBeLessThan(rendered.indexOf("Advanced setup"));
		expect(rendered.indexOf("Advanced setup")).toBeLessThan(rendered.indexOf("Add custom provider"));

		selector.handleInput("\n");
		expect(actions).toEqual(["local-endpoint"]);

		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(actions).toEqual(["local-endpoint", "codex-login"]);

		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(actions).toEqual(["local-endpoint", "codex-login", "claude-login"]);
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

	it("keeps direct login, OAuth, and API guide onboarding actions routed", () => {
		const ctx = createControllerContext({ refresh: async () => undefined } as unknown as ModelRegistry);
		const controller = new SelectorController(ctx);
		const showOAuth = mock(() => undefined);
		controller.showOAuthSelector = showOAuth as unknown as SelectorController["showOAuthSelector"];

		// Local endpoint, Codex login, Claude login, OAuth selector, custom
		// provider, import credentials, API guide.
		for (const [downs, expected] of [
			[1, ["login", "openai-codex"]],
			[2, ["login", "anthropic"]],
			[3, ["login"]],
		] as const) {
			controller.showProviderOnboarding();
			const selector = ctx.ui.focused as ProviderOnboardingSelectorComponent;
			for (let i = 0; i < downs; i++) selector.handleInput("\x1b[B");
			selector.handleInput("\n");
			expect(showOAuth).toHaveBeenLastCalledWith(...expected);
		}

		controller.showProviderOnboarding();
		const selector = ctx.ui.focused as ProviderOnboardingSelectorComponent;
		for (let i = 0; i < 6; i++) selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(ctx.statuses.join("\n")).toContain("Custom API-compatible provider setup:");
	});

	it("falls back to the provider menu when the first-launch connect screen is cancelled", async () => {
		const ctx = createControllerContext({ refresh: async () => undefined } as unknown as ModelRegistry);
		const controller = new SelectorController(ctx);

		const settled = controller.showLocalEndpointOnboarding();
		const connect = ctx.ui.focused as LocalEndpointConnectComponent;
		expect(connect).toBeInstanceOf(LocalEndpointConnectComponent);
		expect(visibleText(connect)).toContain("Connect a local LLM endpoint");

		connect.handleInput("\x1b");
		const menu = ctx.ui.focused as ProviderOnboardingSelectorComponent;
		expect(menu).toBeInstanceOf(ProviderOnboardingSelectorComponent);

		// The promise only settles once the fallback menu itself is dismissed, so
		// the caller does not clobber it with the next startup overlay.
		menu.handleInput("\x1b");
		await settled;
	});

	it("opens the one-screen connect flow from the provider menu, not the old wizard", () => {
		const ctx = createControllerContext({ refresh: async () => undefined } as unknown as ModelRegistry);
		const controller = new SelectorController(ctx);

		controller.showProviderOnboarding();
		const menu = ctx.ui.focused as ProviderOnboardingSelectorComponent;
		menu.handleInput("\n");

		expect(ctx.ui.focused).toBeInstanceOf(LocalEndpointConnectComponent);
	});

	it("registers the endpoint and selects the only served model without a picker", async () => {
		const model = { provider: "local", id: "only-model" };
		const ctx = createModelSelectionContext(model);
		const controller = new SelectorController(ctx);

		const settled = controller.showLocalEndpointOnboarding();
		const connect = ctx.ui.focused as LocalEndpointConnectComponent;
		typeText(connect, "192.168.0.10:8000");
		connect.handleInput("\n");
		await settled;

		expect(ctx.registrations).toEqual([{ baseUrl: "http://192.168.0.10:8000/v1" }]);
		expect(ctx.setModelCalls).toEqual([{ model, role: "default", selector: "local/only-model" }]);
		expect(ctx.modelRoles).toEqual({ default: "local/only-model" });
		// A single model needs no screen, only a status line.
		expect(ctx.statuses.join("\n")).toContain("Default model: local/only-model");
	});

	it("shows the model picker when the endpoint serves several models", async () => {
		const model = { provider: "local", id: "gpt-oss-120b" };
		const ctx = createModelSelectionContext(model, [
			{ id: "qwen3-coder", contextLength: 262144 },
			{ id: "gpt-oss-120b", contextLength: 128000 },
		]);
		const controller = new SelectorController(ctx);

		const settled = controller.showLocalEndpointOnboarding();
		const connect = ctx.ui.focused as LocalEndpointConnectComponent;
		typeText(connect, "192.168.0.10:8000");
		connect.handleInput("\n");
		await flush();

		const picker = ctx.ui.focused as LocalModelPickerComponent;
		expect(picker).toBeInstanceOf(LocalModelPickerComponent);
		expect(visibleText(picker)).toContain("qwen3-coder  262K context");
		picker.handleInput("\x1b[B");
		picker.handleInput("\n");
		await settled;

		expect(ctx.setModelCalls).toEqual([{ model, role: "default", selector: "local/gpt-oss-120b" }]);
		expect(ctx.modelRoles).toEqual({ default: "local/gpt-oss-120b" });
	});
});

type ModelSelectionContext = InteractiveModeContext & {
	statuses: string[];
	ui: { focused?: unknown; requestRender: () => void; setFocus: (component: unknown) => void };
	modelRoles: Record<string, string>;
	registrations: Array<{ baseUrl: string; apiKey?: string }>;
	setModelCalls: Array<{ model: unknown; role: string; selector: string | undefined }>;
};

/**
 * A controller context wired far enough to observe the whole connect flow:
 * registration, the registry lookup, and how the picked model is persisted.
 */
function createModelSelectionContext(
	model: { provider: string; id: string },
	models: localEndpoint.LocalEndpointModel[] = [{ id: model.id }],
): ModelSelectionContext {
	const registrations: Array<{ baseUrl: string; apiKey?: string }> = [];
	const setModelCalls: Array<{ model: unknown; role: string; selector: string | undefined }> = [];
	const modelRoles: Record<string, string> = {};

	probeStub = async () => ({ status: "ok", models });
	registerStub = async input => {
		registrations.push(input);
		return {
			providerId: model.provider,
			compatibility: "openai",
			api: "openai-completions",
			baseUrl: input.baseUrl,
			modelIds: models.map(entry => entry.id),
			modelsPath: "/tmp/models.yml",
			redactedApiKey: "none",
			credentialSource: "literal",
		} as unknown as ProviderSetupResult;
	};

	const registry = {
		refresh: async () => undefined,
		find: (provider: string, modelId: string) =>
			provider === model.provider && modelId === model.id ? model : undefined,
	} as unknown as ModelRegistry;

	const ctx = createControllerContext(registry) as ModelSelectionContext;
	ctx.registrations = registrations;
	ctx.setModelCalls = setModelCalls;
	ctx.modelRoles = modelRoles;
	const mutable = ctx as unknown as Record<string, unknown>;
	mutable.session = {
		modelRegistry: registry,
		setModel: async (selected: unknown, role: string, options?: { selector?: string }) => {
			setModelCalls.push({ model: selected, role, selector: options?.selector });
		},
	};
	mutable.settings = {
		get: () => undefined,
		setModelRole: (role: string, value: string) => {
			modelRoles[role] = value;
		},
		getStorage: () => undefined,
	};
	mutable.statusLine = { invalidate: () => undefined };
	mutable.updateEditorBorderColor = () => undefined;
	return ctx;
}

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
