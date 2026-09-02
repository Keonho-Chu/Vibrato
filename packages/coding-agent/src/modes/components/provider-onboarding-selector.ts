import { Container, matchesKey, Spacer, TruncatedText } from "@vib-rato/tui";
import { theme } from "../../modes/theme/theme";
import { matchesSelectCancel } from "../../modes/utils/keybinding-matchers";
import { formatModelOnboardingGuidance } from "../../setup/model-onboarding-guidance";
import { DynamicBorder } from "./dynamic-border";

export type ProviderOnboardingAction =
	| "local-endpoint"
	| "codex-login"
	| "claude-login"
	| "custom-provider-wizard"
	| "oauth-login"
	| "import-credentials"
	| "api-guide";

interface ProviderOnboardingOption {
	label: string;
	description: string;
	action: ProviderOnboardingAction;
	/** Rendered above this entry as a muted group heading. Not selectable. */
	groupHeading?: string;
	/** The main path. Rendered bold so it does not read as a peer of the rest. */
	primary?: boolean;
}

const PROVIDER_ONBOARDING_OPTIONS: ProviderOnboardingOption[] = [
	{
		label: "Connect a local LLM endpoint",
		description:
			"Connect an OpenAI-compatible LLM server, usually another machine on your network. Models are discovered and registered.",
		action: "local-endpoint",
		primary: true,
	},
	{
		label: "Login with OpenAI Codex",
		description: "Authorize the OpenAI Codex subscription in the browser.",
		action: "codex-login",
		groupHeading: "Other ways to sign in",
	},
	{
		label: "Login with Claude",
		description: "Authorize the Anthropic Claude subscription in the browser.",
		action: "claude-login",
	},
	{
		label: "Login with OAuth/subscription",
		description: "Open the interactive OAuth provider selector for every other login.",
		action: "oauth-login",
	},
	{
		label: "Add custom provider",
		description: "Configure an OpenAI- or Anthropic-compatible API provider interactively.",
		action: "custom-provider-wizard",
		groupHeading: "Advanced setup",
	},
	{
		label: "Import existing credentials",
		description: "Detect and import Claude Code / Codex CLI logins already on this machine.",
		action: "import-credentials",
	},
	{
		label: "Add API-compatible provider",
		description: "Show the /provider add and vib setup provider commands.",
		action: "api-guide",
	},
];

export class ProviderOnboardingSelectorComponent extends Container {
	#listContainer: Container;
	#onCancel: () => void;
	#onSelect: (action: ProviderOnboardingAction) => void;
	#selectedIndex = 0;

	constructor(onSelect: (action: ProviderOnboardingAction) => void, onCancel: () => void) {
		super();
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold("Provider onboarding")));
		this.addChild(new TruncatedText(theme.fg("muted", "  Choose how to configure models for this session."), 0, 0));
		this.addChild(new Spacer(1));
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		this.addChild(new Spacer(1));
		for (const line of formatModelOnboardingGuidance().split("\n")) {
			this.addChild(new TruncatedText(theme.fg("dim", `  ${line}`), 0, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.#updateList();
	}

	#updateList(): void {
		this.#listContainer.clear();
		for (let i = 0; i < PROVIDER_ONBOARDING_OPTIONS.length; i++) {
			const option = PROVIDER_ONBOARDING_OPTIONS[i];
			if (!option) continue;
			const selected = i === this.#selectedIndex;
			if (option.groupHeading) {
				this.#listContainer.addChild(new Spacer(1));
				this.#listContainer.addChild(new TruncatedText(theme.fg("dim", `  ${option.groupHeading}`), 0, 0));
			}
			const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const text = option.primary ? theme.bold(option.label) : option.label;
			const label = selected ? theme.fg("accent", text) : text;
			this.#listContainer.addChild(new TruncatedText(`${prefix}${label}`, 0, 0));
			this.#listContainer.addChild(new TruncatedText(theme.fg("muted", `    ${option.description}`), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "up")) {
			this.#selectedIndex =
				this.#selectedIndex === 0 ? PROVIDER_ONBOARDING_OPTIONS.length - 1 : this.#selectedIndex - 1;
			this.#updateList();
			return;
		}
		if (matchesKey(keyData, "down")) {
			this.#selectedIndex = (this.#selectedIndex + 1) % PROVIDER_ONBOARDING_OPTIONS.length;
			this.#updateList();
			return;
		}
		if (matchesKey(keyData, "enter")) {
			const option = PROVIDER_ONBOARDING_OPTIONS[this.#selectedIndex];
			if (option) this.#onSelect(option.action);
			return;
		}
		if (matchesSelectCancel(keyData)) {
			this.#onCancel();
		}
	}
}
