import { Container, Input, matchesKey, SecretInput, Spacer, Text, TruncatedText } from "@vib-rato/tui";
import { theme } from "../theme/theme";
import { matchesAppInterrupt } from "../utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";
import { formatModelContextLength, type LocalModelChoice } from "./local-model-picker";

/**
 * Outcome of probing one endpoint. Structurally identical to the result of
 * `probeLocalEndpoint` in `setup/local-endpoint.ts`; declared here so this
 * component depends on the setup module only through the injected callbacks.
 */
export type LocalEndpointProbeOutcome =
	| { status: "ok"; models: LocalModelChoice[] }
	| { status: "unauthorized" }
	| { status: "no-models" }
	| { status: "unreachable"; detail: string };

/** A loopback server found by the background probe. */
export interface LocalEndpointSuggestion {
	baseUrl: string;
	label: string;
	models: LocalModelChoice[];
}

/** What the screen hands back once an endpoint answered with models. */
export interface LocalEndpointConnection {
	baseUrl: string;
	apiKey?: string;
	models: LocalModelChoice[];
}

export interface LocalEndpointConnectDeps {
	/** Turn `192.168.0.10:8000` into a full base URL, or explain why it cannot. */
	normalize: (raw: string) => { baseUrl: string } | { error: string };
	probe: (baseUrl: string, apiKey?: string) => Promise<LocalEndpointProbeOutcome>;
	/** Fast concurrent scan of well-known loopback ports. Never blocks the input. */
	discover: () => Promise<LocalEndpointSuggestion[]>;
}

/** Where the ↑/↓ cursor currently sits. */
type ConnectFocus = { kind: "input" } | { kind: "api-key" } | { kind: "suggestion"; index: number };

/**
 * One screen to connect a local (usually LAN) LLM server.
 *
 * The address field is usable the instant the screen opens; loopback servers
 * discovered in the background appear underneath it as extra rows, so detection
 * never becomes a step of its own. There is no API key step and no confirm
 * step: the key field is revealed only when the server answers 401/403, and a
 * successful probe goes straight to the model picker.
 */
export class LocalEndpointConnectComponent extends Container {
	#apiKey = "";
	#apiKeyInput: SecretInput | null = null;
	#apiKeyRequired = false;
	#closed = false;
	#contentContainer: Container;
	#deps: LocalEndpointConnectDeps;
	#error: string | null = null;
	#focus: ConnectFocus = { kind: "input" };
	#input: Input;
	#onCancel: () => void;
	#onRender: () => void;
	#onSubmit: (connection: LocalEndpointConnection) => void | Promise<unknown>;
	#probeInFlight = false;
	#status: string | null = null;
	#submitInFlight = false;
	#suggestions: LocalEndpointSuggestion[] = [];
	#suggestionsPending = true;

	constructor(
		deps: LocalEndpointConnectDeps,
		onSubmit: (connection: LocalEndpointConnection) => void | Promise<unknown>,
		onCancel: () => void,
		onRender: () => void = () => {},
	) {
		super();
		this.#deps = deps;
		this.#onSubmit = onSubmit;
		this.#onCancel = onCancel;
		this.#onRender = onRender;
		this.#input = new Input();

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold("Connect a local LLM endpoint")));
		this.addChild(
			new TruncatedText(
				theme.fg(
					"muted",
					"  Point Vibrato at an OpenAI-compatible LLM server, usually another machine on your network.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.#render();
		this.#startDiscovery();
	}

	/** Wipe the pasted key once the caller is done with it. */
	complete(): void {
		this.#closed = true;
		this.#apiKey = "";
		this.#apiKeyInput?.dispose();
		this.#apiKeyInput = null;
	}

	override dispose(): void {
		this.complete();
		super.dispose();
	}

	/**
	 * Report a failure that happened after the probe succeeded (registering the
	 * provider, refreshing the registry) back onto this screen, so the user edits
	 * and retries instead of landing on a dead end.
	 */
	setSubmitError(error: string): void {
		this.#status = null;
		this.#error = error;
		this.#focus = { kind: "input" };
		this.#render();
		this.#onRender();
	}

	handleInput(keyData: string): void {
		if (this.#closed) return;
		if (matchesAppInterrupt(keyData)) {
			this.complete();
			this.#onCancel();
			return;
		}
		if (matchesKey(keyData, "up")) {
			this.#moveFocus(-1);
			return;
		}
		if (matchesKey(keyData, "down")) {
			this.#moveFocus(1);
			return;
		}
		if (this.#focus.kind === "api-key") {
			// SecretInput owns Enter so the raw key only ever leaves through its
			// one-shot handle.
			this.#ensureApiKeyInput().handleInput(keyData);
			this.#onRender();
			return;
		}
		if (this.#focus.kind === "suggestion") {
			if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
				this.#acceptSuggestion();
			}
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#connectFromInput();
			return;
		}
		this.#input.handleInput(keyData);
		this.#render();
		this.#onRender();
	}

	#startDiscovery(): void {
		void this.#deps.discover().then(
			found => {
				if (this.#closed) return;
				this.#suggestions = found;
				this.#suggestionsPending = false;
				this.#render();
				this.#onRender();
			},
			() => {
				if (this.#closed) return;
				// A failed scan is not an error the user has to act on: they can
				// still type an address.
				this.#suggestions = [];
				this.#suggestionsPending = false;
				this.#render();
				this.#onRender();
			},
		);
	}

	#acceptSuggestion(): void {
		if (this.#focus.kind !== "suggestion") return;
		const suggestion = this.#suggestions[this.#focus.index];
		if (!suggestion) return;
		// The discovery probe already listed this server's models, so it connects
		// without a second round trip.
		this.#emitConnection({ baseUrl: suggestion.baseUrl, models: suggestion.models });
	}

	/** Hand the connection to the caller, ignoring a second Enter while it runs. */
	#emitConnection(connection: LocalEndpointConnection): void {
		if (this.#submitInFlight) return;
		this.#submitInFlight = true;
		let submission: unknown;
		try {
			submission = this.#onSubmit(connection);
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

	#connectFromInput(): void {
		if (this.#probeInFlight || this.#submitInFlight) return;
		const raw = this.#input.getValue().trim();
		if (!raw) {
			this.#error = "Enter the server address first.";
			this.#status = null;
			this.#render();
			this.#onRender();
			return;
		}
		const normalized = this.#deps.normalize(raw);
		if ("error" in normalized) {
			this.#error = normalized.error;
			this.#status = null;
			this.#render();
			this.#onRender();
			return;
		}
		this.#runProbe(normalized.baseUrl);
	}

	#runProbe(baseUrl: string): void {
		this.#probeInFlight = true;
		this.#error = null;
		this.#status = `Connecting to ${baseUrl}…`;
		this.#render();
		this.#onRender();
		const apiKey = this.#apiKey || undefined;
		void this.#deps.probe(baseUrl, apiKey).then(
			outcome => {
				this.#probeInFlight = false;
				if (this.#closed) return;
				this.#applyProbeOutcome(baseUrl, outcome);
			},
			error => {
				this.#probeInFlight = false;
				if (this.#closed) return;
				this.#status = null;
				this.#error = `Could not reach ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`;
				this.#focus = { kind: "input" };
				this.#render();
				this.#onRender();
			},
		);
	}

	#applyProbeOutcome(baseUrl: string, outcome: LocalEndpointProbeOutcome): void {
		this.#status = null;
		if (outcome.status === "ok") {
			const apiKey = this.#apiKey || undefined;
			this.#emitConnection({ baseUrl, ...(apiKey ? { apiKey } : {}), models: outcome.models });
			return;
		}
		if (outcome.status === "unauthorized") {
			this.#error = this.#apiKeyRequired
				? "The server rejected that API key. Try another one."
				: "The server requires an API key.";
			this.#resetApiKeyInput();
			this.#apiKeyRequired = true;
			this.#focus = { kind: "api-key" };
		} else if (outcome.status === "no-models") {
			this.#error = `${baseUrl} answered but serves no models. Load a model on the server, then press Enter again.`;
			this.#focus = { kind: "input" };
		} else {
			this.#error = `Could not reach ${baseUrl}: ${outcome.detail}`;
			this.#focus = { kind: "input" };
		}
		this.#render();
		this.#onRender();
	}

	#ensureApiKeyInput(): SecretInput {
		const existing = this.#apiKeyInput;
		if (existing) return existing;
		const secret = new SecretInput();
		secret.onSubmit = value => this.#submitApiKey(value.consume());
		this.#apiKeyInput = secret;
		return secret;
	}

	/** Drop the typed key so a rejected one is never re-sent or left in memory. */
	#resetApiKeyInput(): void {
		this.#apiKey = "";
		this.#apiKeyInput?.dispose();
		this.#apiKeyInput = null;
	}

	#submitApiKey(secret: string): void {
		if (this.#probeInFlight) return;
		const key = secret.trim();
		if (!key) return;
		this.#apiKey = key;
		const raw = this.#input.getValue().trim();
		const normalized = this.#deps.normalize(raw);
		if ("error" in normalized) {
			this.#error = normalized.error;
			this.#focus = { kind: "input" };
			this.#render();
			this.#onRender();
			return;
		}
		this.#runProbe(normalized.baseUrl);
	}

	/** Focus order: address field, the key field when shown, then each suggestion. */
	#focusTargets(): ConnectFocus[] {
		const targets: ConnectFocus[] = [{ kind: "input" }];
		if (this.#apiKeyRequired) targets.push({ kind: "api-key" });
		for (let i = 0; i < this.#suggestions.length; i++) targets.push({ kind: "suggestion", index: i });
		return targets;
	}

	#focusKey(focus: ConnectFocus): string {
		return focus.kind === "suggestion" ? `suggestion:${focus.index}` : focus.kind;
	}

	#moveFocus(delta: number): void {
		const targets = this.#focusTargets();
		if (targets.length <= 1) return;
		const current = targets.findIndex(target => this.#focusKey(target) === this.#focusKey(this.#focus));
		const next = targets[(Math.max(current, 0) + delta + targets.length) % targets.length];
		if (next) this.#focus = next;
		this.#render();
		this.#onRender();
	}

	/**
	 * Rebuild the screen. `detachAll` rather than `clear` because the address
	 * input and the secret field are long-lived: `clear()` disposes children,
	 * and a disposed SecretInput silently stops accepting keys.
	 */
	#render(): void {
		this.#contentContainer.detachAll();
		const inputFocused = this.#focus.kind === "input";
		this.#contentContainer.addChild(
			new Text(inputFocused ? theme.fg("accent", "Server address") : theme.fg("muted", "Server address"), 0, 0),
		);
		this.#contentContainer.addChild(this.#input);
		// The field starts empty on purpose: the server is normally on another
		// machine, so a loopback default would be wrong far more often than right.
		this.#contentContainer.addChild(
			new TruncatedText(
				theme.fg(
					"muted",
					"  e.g. 192.168.0.10:8000 or gpu-server.lan:8000 — usually another machine on your network.",
				),
				0,
				0,
			),
		);
		this.#contentContainer.addChild(
			new TruncatedText(
				theme.fg(
					"muted",
					"  http:// is assumed for private and .local addresses, https:// otherwise; type the scheme to override. /v1 is filled in for you.",
				),
				0,
				0,
			),
		);

		if (this.#apiKeyRequired) {
			this.#contentContainer.addChild(new Spacer(1));
			const keyFocused = this.#focus.kind === "api-key";
			this.#contentContainer.addChild(
				new Text(keyFocused ? theme.fg("accent", "API key") : theme.fg("muted", "API key"), 0, 0),
			);
			this.#contentContainer.addChild(this.#ensureApiKeyInput());
			this.#contentContainer.addChild(
				new TruncatedText(theme.fg("muted", "  Stored securely and redacted in output."), 0, 0),
			);
		}

		if (this.#status) {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new TruncatedText(theme.fg("muted", this.#status), 0, 0));
		}
		if (this.#error) {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new TruncatedText(theme.fg("error", this.#error), 0, 0));
		}

		this.#renderSuggestions();

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "[↑↓ to move, Enter to connect, Esc for other providers]"), 0, 0),
		);
	}

	#renderSuggestions(): void {
		if (this.#suggestionsPending) {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(
				new TruncatedText(theme.fg("dim", "  Also checking this machine for a local server…"), 0, 0),
			);
			return;
		}
		if (this.#suggestions.length === 0) return;
		// Secondary to the address field: loopback servers are a convenience for
		// the minority who run the model on this machine. Never preselected.
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("dim", "Also found on this machine"), 0, 0));
		for (let i = 0; i < this.#suggestions.length; i++) {
			const suggestion = this.#suggestions[i];
			if (!suggestion) continue;
			const selected = this.#focus.kind === "suggestion" && this.#focus.index === i;
			const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const label = selected ? theme.fg("accent", suggestion.label) : theme.fg("muted", suggestion.label);
			this.#contentContainer.addChild(
				new TruncatedText(`${prefix}${label}${theme.fg("muted", `  ${suggestion.baseUrl}`)}`, 0, 0),
			);
			this.#contentContainer.addChild(
				new TruncatedText(theme.fg("dim", `    ${describeSuggestionModels(suggestion.models)}`), 0, 0),
			);
		}
	}
}

function describeSuggestionModels(models: readonly LocalModelChoice[]): string {
	const first = models[0];
	if (!first) return "no models loaded";
	const context = formatModelContextLength(first.contextLength);
	const head = context ? `${first.id} (${context})` : first.id;
	return models.length === 1 ? head : `${head} +${models.length - 1} more`;
}
