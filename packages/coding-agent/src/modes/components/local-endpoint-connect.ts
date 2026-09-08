import { Container, Input, matchesKey, SecretInput, Spacer, Text, TruncatedText } from "@vib-rato/tui";
import { theme } from "../theme/theme";
import { matchesAppInterrupt } from "../utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";
import { formatModelContextLength, type LocalModelChoice } from "./local-model-picker";

/**
 * Token budget a gateway reported about the key that probed it. Every field is
 * optional: the screen shows what was sent and never fills a gap with a
 * plausible number.
 */
export interface LocalEndpointQuotaFacts {
	limit?: number;
	remaining?: number;
	used?: number;
	resetAt?: number;
}

/** How a server in front of the endpoint announced itself on the model list. */
export interface LocalEndpointGatewayFacts {
	hintedModels: number;
	quota?: LocalEndpointQuotaFacts;
}

/**
 * Outcome of probing one endpoint. Structurally identical to the result of
 * `probeLocalEndpoint` in `setup/local-endpoint.ts`; declared here so this
 * component depends on the setup module only through the injected callbacks.
 */
export type LocalEndpointProbeOutcome =
	| { status: "ok"; models: LocalModelChoice[]; gateway?: LocalEndpointGatewayFacts }
	| { status: "unauthorized" }
	| { status: "quota-exhausted"; quota: LocalEndpointQuotaFacts }
	| { status: "no-models" }
	| { status: "unreachable"; detail: string };

/** A loopback server found by the background probe. */
export interface LocalEndpointSuggestion {
	baseUrl: string;
	label: string;
	models: LocalModelChoice[];
	gateway?: LocalEndpointGatewayFacts;
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
type ConnectFocus =
	| { kind: "input" }
	| { kind: "api-key" }
	| { kind: "suggestion"; index: number }
	/** The gateway summary owns the whole screen while it is shown. */
	| { kind: "summary" };

/** The connection a shown summary will hand over once Enter is pressed. */
export interface PendingGatewaySummary {
	connection: LocalEndpointConnection;
	gateway: LocalEndpointGatewayFacts;
	/** Whether the endpoint was probed with a key at all. */
	authenticated: boolean;
}

/**
 * One screen to connect a local (usually LAN) LLM server.
 *
 * The address field is usable the instant the screen opens; loopback servers
 * discovered in the background appear underneath it as extra rows, so detection
 * never becomes a step of its own. There is no API key step and no confirm
 * step: the key field is revealed only when the server answers 401/403, and a
 * successful probe goes straight to the model picker.
 *
 * The one exception is an endpoint that turns out to be fronted by a gateway.
 * That is worth a beat, because a gateway meters the key rather than merely
 * accepting it, so the screen shows what the gateway reported about the key
 * once and continues on Enter. A plain server never sees this step: the
 * decision is made from signals only a gateway puts on the response, never from
 * the address or the provider name.
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
	#summary: PendingGatewaySummary | null = null;
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
		// The summary owns the screen while it is up, so nothing may reach the
		// address field or the suggestion rows behind it. Enter is the only key
		// that does anything; Esc still leaves the screen the way it always has.
		if (this.#focus.kind === "summary") {
			if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
				this.#acceptSummary();
			}
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
		// without a second round trip. Loopback discovery runs unauthenticated,
		// so a gateway found this way was answering without a key.
		this.#continueWith({ baseUrl: suggestion.baseUrl, models: suggestion.models }, suggestion.gateway, false);
	}

	/**
	 * Hand the connection over, or hold it behind the gateway summary first.
	 *
	 * The summary is a beat, not a gate: it never asks a question, never sends a
	 * request of its own, and Enter continues to exactly where a plain endpoint
	 * would already be.
	 */
	#continueWith(
		connection: LocalEndpointConnection,
		gateway: LocalEndpointGatewayFacts | undefined,
		authenticated: boolean,
	): void {
		if (!gateway) {
			this.#emitConnection(connection);
			return;
		}
		this.#summary = { connection, gateway, authenticated };
		this.#focus = { kind: "summary" };
		this.#error = null;
		this.#status = null;
		this.#render();
		this.#onRender();
	}

	#acceptSummary(): void {
		const summary = this.#summary;
		if (!summary) return;
		this.#emitConnection(summary.connection);
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
			this.#continueWith(
				{ baseUrl, ...(apiKey ? { apiKey } : {}), models: outcome.models },
				outcome.gateway,
				apiKey !== undefined,
			);
			return;
		}
		if (outcome.status === "quota-exhausted") {
			// Not a broken connection: the key is good and the gateway said so by
			// reporting the budget it just refused to spend.
			this.#error = describeExhaustedQuota(outcome.quota, Date.now());
			this.#focus = { kind: "input" };
			this.#render();
			this.#onRender();
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
		if (this.#focus.kind === "summary") return [{ kind: "summary" }];
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
		if (this.#focus.kind === "summary" && this.#summary) {
			this.#renderGatewaySummary(this.#summary);
			return;
		}
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
			// One row per line: `TruncatedText` cuts rather than wraps, so a message
			// that needs two rows has to arrive already split.
			for (const line of this.#error.split("\n")) {
				this.#contentContainer.addChild(new TruncatedText(theme.fg("error", line), 0, 0));
			}
		}

		this.#renderSuggestions();

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "[↑↓ to move, Enter to connect, Esc for other providers]"), 0, 0),
		);
	}

	/**
	 * The gateway beat: what the gateway said about this key, and nothing the
	 * client had to ask for. Every line is a fact from the model-list response,
	 * so a gateway that reports no budget says so plainly rather than showing a
	 * zero or a guessed window.
	 */
	#renderGatewaySummary(summary: PendingGatewaySummary): void {
		const gateway = summary.gateway;
		this.#contentContainer.addChild(new TruncatedText(theme.bold("Usage gateway"), 0, 0));
		this.#contentContainer.addChild(
			new TruncatedText(
				theme.fg("muted", "  This endpoint is fronted by a server that meters requests per key."),
				0,
				0,
			),
		);
		this.#contentContainer.addChild(new Spacer(1));
		for (const row of gatewaySummaryRows(summary, Date.now())) {
			this.#contentContainer.addChild(
				new TruncatedText(`  ${theme.fg("muted", row.label.padEnd(SUMMARY_LABEL_WIDTH))}${row.value}`, 0, 0),
			);
		}
		if (!gateway.quota) {
			this.#contentContainer.addChild(new Spacer(1));
			for (const line of NO_QUOTA_ON_MODEL_LIST) {
				this.#contentContainer.addChild(new TruncatedText(theme.fg("dim", `  ${line}`), 0, 0));
			}
		}
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "[Enter to continue, Esc for other providers]"), 0, 0),
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

/** Label column of the summary rows. Wide enough for the longest label below. */
const SUMMARY_LABEL_WIDTH = 14;

/**
 * Said only when the gateway reported no budget on the model list. It is a
 * statement about this response, not a promise about the gateway's design, and
 * it names no window length: the window is the operator's setting and the client
 * is never told what it is.
 */
const NO_QUOTA_ON_MODEL_LIST = [
	"The model list carries no budget figures. Your key's usage appears in the",
	"status line once the first request comes back.",
] as const;

/** One `label  value` line of the summary. */
interface GatewaySummaryRow {
	label: string;
	value: string;
}

/**
 * The summary's content, separated from its rendering so a test reads the same
 * strings the screen draws.
 */
export function gatewaySummaryRows(summary: PendingGatewaySummary, now: number): GatewaySummaryRow[] {
	const { connection, gateway, authenticated } = summary;
	const rows: GatewaySummaryRow[] = [
		{ label: "Address", value: connection.baseUrl },
		{ label: "Models", value: describeModelCount(connection.models.length, gateway.hintedModels) },
		{
			label: "API key",
			value: authenticated ? "accepted by the gateway" : "not required by this endpoint",
		},
	];
	const budget = describeBudget(gateway.quota);
	if (budget) rows.push({ label: "Token budget", value: budget });
	const reset = gateway.quota ? describeReset(gateway.quota.resetAt, now) : undefined;
	if (reset) rows.push({ label: "Resets", value: reset });
	return rows;
}

function describeModelCount(total: number, hinted: number): string {
	const models = `${total} available`;
	// A hinted entry is the server describing what the model supports, which is
	// why the endpoint needs no models.yml block. Worth naming, briefly.
	return hinted > 0 ? `${models}, ${hinted} described by the server` : models;
}

/**
 * Remaining against the limit, using only the halves the gateway actually sent.
 * A lone limit is still worth showing; a lone remaining is not, because
 * "142,000 left" of an unknown budget says nothing.
 */
function describeBudget(quota: LocalEndpointQuotaFacts | undefined): string | undefined {
	if (!quota || quota.limit === undefined) return undefined;
	const limit = formatTokens(quota.limit);
	if (quota.remaining !== undefined) return `${formatTokens(quota.remaining)} of ${limit} tokens left`;
	if (quota.used !== undefined) return `${formatTokens(quota.used)} of ${limit} tokens used`;
	return `${limit} tokens per window`;
}

function formatTokens(count: number): string {
	return count.toLocaleString("en-US");
}

/**
 * Countdown plus the wall-clock instant it lands on, e.g. `2h 30m (21:00)`.
 *
 * Nothing here names the window: the gateway reports when the budget comes back
 * and never how long the window is, so the client says when and not how often. A
 * reset already in the past describes a window that has closed and is dropped
 * rather than shown as `0m`.
 */
export function describeReset(resetAt: number | undefined, now: number): string | undefined {
	if (resetAt === undefined || !Number.isFinite(resetAt) || resetAt <= now) return undefined;
	const minutes = Math.round((resetAt - now) / 60_000);
	const hours = Math.floor(minutes / 60);
	const relative = hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
	return `${relative} (${formatResetClock(new Date(resetAt), new Date(now))})`;
}

/** Local `HH:MM`, dated only when the reset falls on another local day. */
function formatResetClock(reset: Date, now: Date): string {
	const clock = `${pad2(reset.getHours())}:${pad2(reset.getMinutes())}`;
	const sameDay =
		reset.getFullYear() === now.getFullYear() &&
		reset.getMonth() === now.getMonth() &&
		reset.getDate() === now.getDate();
	return sameDay ? clock : `${pad2(reset.getMonth() + 1)}-${pad2(reset.getDate())} ${clock}`;
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

/**
 * The inline message for a gateway that refused the model list because the key's
 * budget is spent. Two rows, because the screen truncates rather than wraps.
 */
export function describeExhaustedQuota(quota: LocalEndpointQuotaFacts, now: number): string {
	const spent =
		quota.used !== undefined && quota.limit !== undefined
			? ` (${formatTokens(quota.used)}/${formatTokens(quota.limit)})`
			: quota.limit !== undefined
				? ` (limit ${formatTokens(quota.limit)})`
				: "";
	const reset = describeReset(quota.resetAt, now);
	return [
		`The key is valid; its token budget for this window is spent${spent}.`,
		reset ? `It comes back in ${reset}. Press Enter to try again then.` : "Press Enter to try again later.",
	].join("\n");
}

function describeSuggestionModels(models: readonly LocalModelChoice[]): string {
	const first = models[0];
	if (!first) return "no models loaded";
	const context = formatModelContextLength(first.contextLength);
	const head = context ? `${first.id} (${context})` : first.id;
	return models.length === 1 ? head : `${head} +${models.length - 1} more`;
}
