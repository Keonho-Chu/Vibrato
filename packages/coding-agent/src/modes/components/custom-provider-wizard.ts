import { Container, Input, matchesKey, SecretInput, Spacer, Text, TruncatedText } from "@vib-rato/tui";
import type { ProviderCompatibility, ProviderSetupInput } from "../../setup/provider-onboarding";
import { theme } from "../theme/theme";
import { matchesAppInterrupt } from "../utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";

export type CustomProviderCredentialSource = "env" | "literal";

type WizardStep =
	| "compatibility"
	| "provider-id"
	| "base-url"
	| "credential-source"
	| "credential"
	| "models"
	| "confirm"
	| "force-confirm";

interface WizardState {
	compatibility: ProviderCompatibility;
	providerId: string;
	baseUrl: string;
	credentialSource: CustomProviderCredentialSource;
	credential: string;
	models: string;
}

export type CustomProviderWizardSubmit = ProviderSetupInput;

/** Endpoint presets that collapse the wizard to "base URL + API key". */
export type CustomProviderWizardPreset = "vllm" | "sglang";

interface WizardPresetSpec {
	providerId: string;
	title: string;
	subtitle: string;
	defaultBaseUrl: string;
	/** Token stored when the user leaves the key empty for an unauthenticated local server. */
	localToken?: string;
}

const WIZARD_PRESETS: Record<CustomProviderWizardPreset, WizardPresetSpec> = {
	vllm: {
		providerId: "vllm",
		title: "Connect a vLLM endpoint",
		subtitle: "  Enter the vLLM server URL and API key. Models are discovered from the server.",
		defaultBaseUrl: "http://127.0.0.1:8000/v1",
		localToken: "vllm-local",
	},
	sglang: {
		providerId: "sglang",
		title: "Connect an SGLang endpoint",
		subtitle: "  Enter the SGLang server URL and API key. Models are discovered from the server.",
		defaultBaseUrl: "http://127.0.0.1:30000/v1",
	},
};

export interface CustomProviderWizardOptions {
	preset?: CustomProviderWizardPreset;
}

export class CustomProviderWizardComponent extends Container {
	#contentContainer: Container;
	#input: Input | SecretInput | null = null;
	#step: WizardStep = "compatibility";
	#selectedIndex = 0;
	#lastSubmitError: string | null = null;
	#state: WizardState = {
		compatibility: "openai",
		providerId: "",
		baseUrl: "",
		credentialSource: "env",
		credential: "",
		models: "",
	};
	#submitInFlight = false;
	#onSubmit: (input: CustomProviderWizardSubmit) => void;
	#onCancel: () => void;
	#onRender: () => void;
	#preset: WizardPresetSpec | null = null;
	#presetId: CustomProviderWizardPreset | null = null;

	constructor(
		onSubmit: (input: CustomProviderWizardSubmit) => void,
		onCancel: () => void,
		onRender: () => void = () => {},
		options: CustomProviderWizardOptions = {},
	) {
		super();
		this.#onSubmit = onSubmit;
		this.#onCancel = onCancel;
		this.#onRender = onRender;
		if (options.preset) {
			this.#presetId = options.preset;
			this.#preset = WIZARD_PRESETS[options.preset];
			this.#state = {
				compatibility: "openai",
				providerId: this.#preset.providerId,
				baseUrl: this.#preset.defaultBaseUrl,
				credentialSource: "literal",
				credential: "",
				models: "",
			};
			this.#step = "base-url";
		}

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold(this.#preset?.title ?? "Add custom provider")));
		this.addChild(
			new TruncatedText(
				theme.fg("muted", this.#preset?.subtitle ?? "  Configure an OpenAI- or Anthropic-compatible API provider."),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.#renderStep();
	}

	setSubmitError(error: string): void {
		this.#lastSubmitError = error;
		if (error.includes("already exists")) {
			this.#step = "force-confirm";
			this.#selectedIndex = 1;
		}
		this.#renderStep();
		this.#onRender();
	}

	handleInput(keyData: string): void {
		if (matchesAppInterrupt(keyData)) {
			if (this.#step === "compatibility" || (this.#preset && this.#step === "base-url")) {
				this.#clearLiteralCredential();
				this.#onCancel();
				return;
			}
			this.#goBack();
			return;
		}

		if (this.#input) {
			if (this.#input instanceof SecretInput) {
				this.#input.handleInput(keyData);
				return;
			}
			if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
				this.#saveInputAndProceed();
				return;
			}
			this.#input.handleInput(keyData);
			return;
		}

		if (matchesKey(keyData, "up")) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesKey(keyData, "down")) {
			this.#moveSelection(1);
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#selectCurrentOption();
		}
	}

	#renderStep(): void {
		this.#contentContainer.clear();
		this.#input = null;
		switch (this.#step) {
			case "compatibility":
				this.#renderCompatibilityStep();
				break;
			case "provider-id":
				this.#renderInputStep(
					"Step 2: Provider id",
					"Enter a provider id:",
					this.#state.providerId,
					"e.g. my-openai-proxy",
				);
				break;
			case "base-url":
				this.#renderInputStep(
					this.#preset ? "Step 1: Server URL" : "Step 3: Base URL",
					this.#preset ? `Enter the ${this.#preset.providerId} server base URL:` : "Enter the API base URL:",
					this.#state.baseUrl,
					this.#preset
						? "http:// is accepted for localhost and private-network hosts; use https:// elsewhere."
						: "e.g. https://api.example.com/v1",
				);
				break;
			case "credential-source":
				this.#renderCredentialSourceStep();
				break;
			case "credential":
				if (this.#state.credentialSource === "env") {
					this.#renderInputStep(
						"Step 5: Credential",
						"Enter the API key environment variable name:",
						this.#state.credential,
						"e.g. OPENAI_API_KEY",
					);
				} else {
					this.#renderSecretInputStep();
				}
				break;
			case "models":
				this.#renderInputStep(
					"Step 6: Model id(s)",
					"Enter model ids, comma-separated:",
					this.#state.models,
					"e.g. gpt-5, claude-sonnet-4-5",
				);
				break;
			case "confirm":
				this.#renderConfirmStep(false);
				break;
			case "force-confirm":
				this.#renderConfirmStep(true);
				break;
		}
	}

	#renderCompatibilityStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 1: Compatibility")));
		this.#contentContainer.addChild(new Spacer(1));
		const options: Array<{ value: ProviderCompatibility; label: string }> = [
			{ value: "openai", label: "OpenAI-compatible" },
			{ value: "anthropic", label: "Anthropic-compatible" },
		];
		for (let i = 0; i < options.length; i++) this.#addOption(i, options[i]?.label ?? "");
		this.#addHelp("[↑↓ to navigate, Enter to select, Esc to cancel]");
	}

	#renderCredentialSourceStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 4: Credential source")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#addOption(0, "Environment variable");
		this.#addOption(1, "Paste API key");
		this.#addHelp("[↑↓ to navigate, Enter to select, Esc to go back]");
	}

	#renderInputStep(title: string, prompt: string, value: string, hint: string): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", title)));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(prompt, 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#input = new Input();
		this.#input.setValue(value);
		this.#contentContainer.addChild(this.#input);
		this.#contentContainer.addChild(new Spacer(1));
		this.#addHelp(hint);
		this.#addHelp("[Enter to continue, Esc to go back]");
	}

	#renderSecretInputStep(): void {
		const preset = this.#preset;
		this.#contentContainer.addChild(new Text(theme.fg("accent", preset ? "Step 2: API key" : "Step 5: Credential")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Paste the API key:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		const input = new SecretInput();
		input.onSubmit = secret => {
			const credential = secret.consume().trim();
			if (!credential && !preset?.localToken) return;
			this.#state.credential = credential || (preset?.localToken ?? "");
			this.#step = preset ? "confirm" : "models";
			this.#selectedIndex = 0;
			this.#lastSubmitError = null;
			this.#renderStep();
			this.#onRender();
		};
		this.#input = input;
		this.#contentContainer.addChild(input);
		this.#contentContainer.addChild(new Spacer(1));
		this.#addHelp("The key will be stored securely and redacted in output.");
		if (preset?.localToken) this.#addHelp("Leave empty for an unauthenticated local server.");
		this.#addHelp("[Enter to continue, Esc to go back]");
	}

	#renderConfirmStep(force: boolean): void {
		this.#contentContainer.addChild(
			new Text(theme.fg("accent", force ? "Provider exists — replace it?" : "Confirm custom provider")),
		);
		this.#contentContainer.addChild(new Spacer(1));
		if (this.#lastSubmitError) {
			this.#contentContainer.addChild(new Text(theme.fg(force ? "warning" : "error", this.#lastSubmitError), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
		}
		this.#contentContainer.addChild(new Text(`Compatibility: ${this.#state.compatibility}`, 0, 0));
		this.#contentContainer.addChild(new Text(`Provider: ${this.#state.providerId}`, 0, 0));
		this.#contentContainer.addChild(new Text(`Base URL: ${this.#state.baseUrl}`, 0, 0));
		const credentialLabel =
			this.#state.credentialSource === "env"
				? this.#state.credential
				: this.#preset?.localToken && this.#state.credential === this.#preset.localToken
					? "none (unauthenticated local server)"
					: "pasted API key";
		this.#contentContainer.addChild(new Text(`Credential: ${credentialLabel}`, 0, 0));
		this.#contentContainer.addChild(
			new Text(`Models: ${this.#preset ? "discovered from the server" : this.#state.models}`, 0, 0),
		);
		this.#contentContainer.addChild(new Spacer(1));
		this.#addOption(0, force ? "Replace existing provider" : "Add provider");
		this.#addOption(1, "Go back");
		this.#addHelp("[↑↓ to navigate, Enter to select, Esc to go back]");
	}

	#addOption(index: number, label: string): void {
		const selected = index === this.#selectedIndex;
		const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
		this.#contentContainer.addChild(new Text(`${prefix}${selected ? theme.fg("accent", label) : label}`, 0, 0));
	}

	#addHelp(text: string): void {
		this.#contentContainer.addChild(new Text(theme.fg("muted", text), 0, 0));
	}

	#saveInputAndProceed(): void {
		if (!(this.#input instanceof Input)) return;
		const value = this.#input.getValue().trim();
		if (!value) return;
		if (this.#step === "provider-id") {
			this.#state.providerId = value;
			this.#step = "base-url";
		} else if (this.#step === "base-url") {
			this.#state.baseUrl = value;
			this.#step = this.#preset ? "credential" : "credential-source";
			this.#selectedIndex = 0;
		} else if (this.#step === "credential") {
			this.#state.credential = value;
			this.#step = "models";
		} else if (this.#step === "models") {
			this.#state.models = value;
			this.#step = "confirm";
			this.#selectedIndex = 0;
			this.#lastSubmitError = null;
		}
		this.#renderStep();
		this.#onRender();
	}

	#selectCurrentOption(): void {
		if (this.#step === "compatibility") {
			this.#state.compatibility = this.#selectedIndex === 0 ? "openai" : "anthropic";
			this.#step = "provider-id";
		} else if (this.#step === "credential-source") {
			this.#state.credentialSource = this.#selectedIndex === 0 ? "env" : "literal";
			this.#state.credential = "";
			this.#step = "credential";
		} else if (this.#step === "confirm" || this.#step === "force-confirm") {
			if (this.#selectedIndex === 0) {
				this.#submit();
				return;
			}
			this.#step = "models";
		}
		this.#renderStep();
		this.#onRender();
	}

	#submit(): void {
		if (this.#submitInFlight) return;
		this.#submitInFlight = true;
		let submission: unknown;
		try {
			submission = this.#onSubmit(this.#buildInput(this.#step === "force-confirm"));
		} catch (error) {
			this.#submitInFlight = false;
			throw error;
		}
		if (!(submission instanceof Promise)) {
			this.#submitInFlight = false;
			return;
		}
		void submission.then(
			() => {
				this.#submitInFlight = false;
			},
			() => {
				this.#submitInFlight = false;
			},
		);
	}

	#buildInput(force: boolean): CustomProviderWizardSubmit {
		if (this.#presetId) {
			return {
				preset: this.#presetId,
				baseUrl: this.#state.baseUrl,
				apiKey: this.#state.credential,
				force,
			};
		}
		const input = {
			compatibility: this.#state.compatibility,
			providerId: this.#state.providerId,
			baseUrl: this.#state.baseUrl,
			apiKeyEnv: this.#state.credentialSource === "env" ? this.#state.credential : undefined,
			apiKey: this.#state.credentialSource === "literal" ? this.#state.credential : undefined,
			models: this.#state.models
				.split(",")
				.map(model => model.trim())
				.filter(Boolean),
			force,
		};

		return input;
	}

	complete(): void {
		this.#clearLiteralCredential();
	}

	#clearLiteralCredential(): void {
		if (this.#state.credentialSource === "literal") this.#state.credential = "";
	}

	#moveSelection(delta: number): void {
		const maxIndex =
			this.#step === "confirm" ||
			this.#step === "force-confirm" ||
			this.#step === "compatibility" ||
			this.#step === "credential-source"
				? 1
				: 0;
		this.#selectedIndex = (this.#selectedIndex + delta + maxIndex + 1) % (maxIndex + 1);
		this.#renderStep();
		this.#onRender();
	}

	#goBack(): void {
		if (this.#preset) {
			if (this.#step === "credential") this.#step = "base-url";
			else if (this.#step === "confirm" || this.#step === "force-confirm") this.#step = "credential";
			this.#selectedIndex = 0;
			this.#renderStep();
			this.#onRender();
			return;
		}
		if (this.#step === "provider-id") this.#step = "compatibility";
		else if (this.#step === "base-url") this.#step = "provider-id";
		else if (this.#step === "credential-source") this.#step = "base-url";
		else if (this.#step === "credential") this.#step = "credential-source";
		else if (this.#step === "models") this.#step = "credential";
		else if (this.#step === "confirm" || this.#step === "force-confirm") this.#step = "models";
		this.#selectedIndex = 0;
		this.#renderStep();
		this.#onRender();
	}
}
