/**
 * Gateway quota and congestion observation.
 *
 * The VUG gateway reports a per-key token budget for the current quota window
 * on the responses it already returns: success responses carry
 * `x-vug-daily-limit` / `x-vug-daily-remaining` / `x-vug-daily-reset` /
 * `x-vug-queued-ms`, a token-limit rejection (429) carries
 * `x-vug-daily-limit` / `x-vug-daily-used` / `x-vug-daily-reset`, and an
 * admission rejection (503) carries `x-vug-queue-depth` / `x-vug-inflight` /
 * `retry-after`. There is no endpoint that reports the calling key's quota on
 * demand — `GET /v1/models` does not attach these headers — so response
 * observation is the only source, and this module is deliberately passive: it
 * never issues a request of its own and never reads `/metrics`, `/admin`, or
 * `/healthz`.
 *
 * The `daily` in those header names is historical. The gateway counts against a
 * configurable window (`VUG_QUOTA_WINDOW_HOURS`, three hours in production), and
 * keeps the names for wire-contract stability, so read every `x-vug-daily-*`
 * name as "per quota window". Nothing here may assume twenty-four hours, a
 * midnight boundary, or a calendar day: the window length is never sent, and the
 * only thing that says when the budget refills is `x-vug-daily-reset`.
 *
 * Invariants this module exists to hold:
 *
 * - **Only the selected names are read.** Everything else on the response is
 *   ignored, so an arbitrary provider header can never reach the status line.
 * - **Nothing is persisted.** State lives in memory for the life of the
 *   observer. It is never written to the transcript or to session files.
 * - **State belongs to one key.** The key is (provider + baseUrl, credential
 *   fingerprint, session id). Observing under a different key discards the
 *   previous state outright, so a key rotation, gateway switch, or new session
 *   can never show another account's quota. The credential half is a digest of
 *   the credential actually resolved for the request, not the session-scoped
 *   selector, because the selector is fixed for the life of the session while
 *   the credential behind it can rotate mid-session.
 * - **`remaining` is a past observation, not a live balance.** The gateway
 *   samples it when the request is admitted, before that request's own tokens
 *   are charged. Nothing here decrements it locally to make it look
 *   authoritative, and with requests in flight in parallel the most recent
 *   observation simply wins.
 * - **No value is invented.** A field that was not observed stays `undefined`,
 *   which the projection turns into an omitted window rather than a `0%` or a
 *   "free" label. `resetAt` in particular exists only when the gateway sent an
 *   unambiguous instant; the client never guesses a window boundary or a timezone.
 */

import { createHash } from "node:crypto";

/** Success-path headers. */
const HEADER_DAILY_LIMIT = "x-vug-daily-limit";
const HEADER_DAILY_REMAINING = "x-vug-daily-remaining";
const HEADER_DAILY_RESET = "x-vug-daily-reset";
const HEADER_QUEUED_MS = "x-vug-queued-ms";
/** Token-limit rejection (429) headers. */
const HEADER_DAILY_USED = "x-vug-daily-used";
/** Admission rejection (503) headers. */
const HEADER_QUEUE_DEPTH = "x-vug-queue-depth";
const HEADER_INFLIGHT = "x-vug-inflight";
const HEADER_RETRY_AFTER = "retry-after";

/**
 * This observer's complete read set: every header name it looks at, and the
 * only names it looks at. Exported so a test can pin the set, since the reason
 * to keep it small is a privacy boundary rather than a style preference.
 *
 * The `x-vug-*` entries are the gateway's own. `retry-after` is the one
 * standard header in the set; it is read solely to time an admission rejection,
 * and only when that response also carried a gateway queue header, so an
 * ordinary provider 503 is never mistaken for gateway congestion.
 */
export const GATEWAY_QUOTA_HEADER_NAMES = [
	HEADER_DAILY_LIMIT,
	HEADER_DAILY_REMAINING,
	HEADER_DAILY_RESET,
	HEADER_DAILY_USED,
	HEADER_QUEUED_MS,
	HEADER_QUEUE_DEPTH,
	HEADER_INFLIGHT,
	HEADER_RETRY_AFTER,
] as const;

/**
 * The subset that identifies a response as the gateway's. `retry-after` is
 * excluded deliberately: any provider may send it, so it is evidence about
 * timing, never about who answered.
 */
const GATEWAY_SIGNAL_HEADER_SET: ReadonlySet<string> = new Set(
	GATEWAY_QUOTA_HEADER_NAMES.filter(name => name !== HEADER_RETRY_AFTER),
);

/**
 * Whether a response carries any gateway quota header at all.
 *
 * Synchronous and allocation-free by design. A caller must be able to decide
 * "this response is not the gateway's" before doing any work on it — resolving
 * a credential to fingerprint, above all. Credential resolution is not a pure
 * read in this codebase: the registry's `getApiKey` refreshes rotating config
 * keys, rewrites the model's `Authorization` header, and on the OAuth branch is
 * the token-refresh path. None of that may be triggered by a response from a
 * provider that has nothing to do with the gateway.
 */
export function hasGatewayQuotaHeaders(headers: Readonly<Record<string, string | undefined>> | undefined): boolean {
	if (!headers) return false;
	for (const key of Object.keys(headers)) {
		if (typeof headers[key] !== "string") continue;
		if (GATEWAY_SIGNAL_HEADER_SET.has(key.toLowerCase())) return true;
	}
	return false;
}

/**
 * Identity that owns an observation. Two observations share state only when
 * every field matches; anything else is a different account, gateway, or run.
 *
 * `credentialId` is a one-way digest of the credential that was actually
 * resolved for the request — see {@link fingerprintCredential} — never the
 * secret itself and never the session-scoped selector. The selector is assigned
 * once when the session is constructed and never reassigned, so keying on it
 * would reduce the identity to (provider, baseUrl) for the whole session: a
 * credential that rotates mid-session (an exhausted key giving way to the next
 * one) would then keep the previous key's budget and reset instant and merge
 * them with the new key's next observation.
 */
export interface GatewayQuotaKey {
	provider: string;
	baseUrl: string;
	credentialId: string;
	sessionId: string;
}

/**
 * Non-reversible, non-secret identifier for a resolved credential.
 *
 * Only equality matters here: the observer needs to know that the credential
 * behind this response differs from the credential behind the last one. A
 * truncated SHA-256 answers that without the state, the status line, or a
 * crash dump ever holding key material. An unresolved credential falls back to
 * the caller's session-scoped selector, which keeps sessions isolated from each
 * other rather than collapsing every unauthenticated session into one bucket.
 */
export function fingerprintCredential(secret: string | undefined, sessionScope: string): string {
	if (typeof secret !== "string" || secret.length === 0) return `scope:${sessionScope}`;
	return `sha256:${createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 16)}`;
}

/** Gateway admission pressure reported by a 503. */
export interface GatewayBusyState {
	code: number;
	queueDepth?: number;
	inflight?: number;
	retryAfterMs?: number;
}

/** Token budget exhaustion reported by a 429. */
export interface GatewayExhaustedState {
	used?: number;
	limit?: number;
	resetAt?: number;
}

export interface GatewayQuotaState {
	key: GatewayQuotaKey;
	/** When the most recent accepted observation was made. */
	observedAt: number;
	/** Token budget for the key in the current quota window, as last reported. */
	limit?: number;
	/** Budget left when the last observed request was admitted. Never decremented locally. */
	remaining?: number;
	/** Only set when the gateway sent an unambiguous reset instant. */
	resetAt?: number;
	/** How long the last observed request waited for a slot. A past duration, not an ETA. */
	lastQueuedMs?: number;
	busy?: GatewayBusyState;
	exhausted?: GatewayExhaustedState;
}

export interface GatewayQuotaObservation {
	key: GatewayQuotaKey;
	/**
	 * Which boundary produced this observation, stated by the call site rather
	 * than inferred from the status.
	 *
	 * A served response and a failed one are not distinguishable by status
	 * alone: a transport failure can arrive with no status at all (a socket
	 * error, a typed provider code carried inside an HTTP 200 envelope). Reading
	 * a missing status as "served" would let such a failure clear a real
	 * limit-reached or congestion note, which is the opposite of what happened.
	 */
	kind: "success" | "failure";
	/** HTTP status. Only an explicit 2xx, 429, or 503 carries gateway quota facts. */
	status?: number;
	/** Response headers. Case is normalized here, so either casing is accepted. */
	headers?: Readonly<Record<string, string | undefined>>;
	/** Observation instant. Defaults to now; an older instant loses to a newer one. */
	at?: number;
}

/** A status-line usage window projected from observed state. */
export interface GatewayUsageWindow {
	label: string;
	/** Omitted when no used/limit pair was observed, so no fake `0%` is drawn. */
	percent?: number;
	resetValue?: number;
	resetUnit?: "m" | "h";
	/** Short condition wording for a limit-reached or congested gateway. */
	note?: string;
}

/**
 * What the status line calls the gateway window.
 *
 * Deliberately fixed, and deliberately not `key.provider`. The provider key is
 * whatever the operator happened to name the entry in `models.yml` — the
 * deployment guide registers the gateway as `vllm`, because that is what sits
 * behind it — so keying the label off it renders `vllm 75%` and reads as the
 * GPU box's own budget rather than the allowance the gateway is holding. The
 * quota is the gateway's: it is the party that counts it, enforces it, and
 * reports it under its own `x-vug-*` names, so the window is named after the
 * gateway no matter which provider entry the request went out through.
 *
 * `provider` stays in {@link GatewayQuotaKey}, where it does a different job:
 * binding an observation to one identity so a different provider entry can
 * never inherit this one's budget.
 */
const GATEWAY_LABEL = "vug";

/** Below this an integer cannot be an epoch instant in either seconds or ms. */
const MIN_EPOCH_SECONDS = 1_000_000_000;
const MIN_EPOCH_MILLISECONDS = 100_000_000_000;
const MAX_EPOCH_MILLISECONDS = 100_000_000_000_000;

function lowerCaseHeaders(
	headers: Readonly<Record<string, string | undefined>> | undefined,
): Map<string, string> | undefined {
	if (!headers) return undefined;
	let map: Map<string, string> | undefined;
	for (const key of Object.keys(headers)) {
		const value = headers[key];
		if (typeof value !== "string") continue;
		map ??= new Map<string, string>();
		map.set(key.toLowerCase(), value);
	}
	return map;
}

/**
 * Strict non-negative integer. Deliberately rejects exponent and decimal forms
 * so a malformed header is dropped rather than coerced into a plausible count.
 */
function parseCount(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return undefined;
	const value = Number(trimmed);
	if (!Number.isSafeInteger(value) || value < 0) return undefined;
	return value;
}

/**
 * Reset instant, accepted only in forms that carry their own time reference:
 * an epoch value (seconds or milliseconds) or an ISO-8601 timestamp with an
 * explicit `Z` or `±HH:MM` offset. A bare local datetime such as
 * `2026-09-09T00:00:00` is rejected, because resolving it would mean guessing
 * the gateway's timezone.
 */
function parseResetInstant(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return undefined;
	if (/^\d+$/.test(trimmed)) {
		const value = Number(trimmed);
		if (!Number.isSafeInteger(value)) return undefined;
		if (value >= MIN_EPOCH_MILLISECONDS && value < MAX_EPOCH_MILLISECONDS) return value;
		if (value >= MIN_EPOCH_SECONDS && value < MIN_EPOCH_MILLISECONDS) return value * 1000;
		return undefined;
	}
	if (!/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
		return undefined;
	}
	const parsed = Date.parse(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** `Retry-After`, in either the delta-seconds or the HTTP-date form. */
function parseRetryAfterMs(raw: string | undefined, now: number): number | undefined {
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return undefined;
	if (/^\d+$/.test(trimmed)) {
		const seconds = Number(trimmed);
		if (!Number.isSafeInteger(seconds)) return undefined;
		return seconds * 1000;
	}
	const parsed = Date.parse(trimmed);
	if (!Number.isFinite(parsed)) return undefined;
	return Math.max(0, parsed - now);
}

function sameKey(a: GatewayQuotaKey, b: GatewayQuotaKey): boolean {
	return (
		a.provider === b.provider &&
		a.baseUrl === b.baseUrl &&
		a.credentialId === b.credentialId &&
		a.sessionId === b.sessionId
	);
}

function freezeKey(key: GatewayQuotaKey): GatewayQuotaKey {
	return Object.freeze({
		provider: key.provider,
		baseUrl: key.baseUrl,
		credentialId: key.credentialId,
		sessionId: key.sessionId,
	});
}

/**
 * Holds the most recent gateway observation for a single key.
 *
 * One observer instance belongs to one session. It keeps at most one state,
 * because the session talks to one gateway key at a time; switching keys
 * replaces the state rather than accumulating a per-account cache that could
 * later be shown against the wrong credential.
 */
export class GatewayQuotaObserver {
	#state: GatewayQuotaState | null = null;

	/** Most recent state, or `null` when this session has never seen a gateway header. */
	get state(): GatewayQuotaState | null {
		return this.#state;
	}

	/** Drop everything observed so far. */
	clear(): void {
		this.#state = null;
	}

	/**
	 * Fold one response into the state. Returns whether the state changed, so a
	 * caller can skip a redraw on a response that carried nothing new.
	 *
	 * A response with none of the selected headers for its status is not a
	 * gateway quota signal and leaves existing state untouched: a request routed
	 * past the gateway's captured paths must not erase a real observation. So is
	 * any status the gateway does not use to report quota, and any failure that
	 * arrived without a status at all.
	 */
	observe(observation: GatewayQuotaObservation): boolean {
		const at = Number.isFinite(observation.at) ? (observation.at as number) : Date.now();
		const headers = lowerCaseHeaders(observation.headers);
		if (!headers) return false;
		const status = observation.status;

		if (observation.kind === "failure") {
			if (status === 429) return this.#applyExhausted(observation.key, headers, at);
			if (status === 503) return this.#applyBusy(observation.key, headers, at);
			return false;
		}
		// Served requests must prove it with an explicit 2xx. Anything else did
		// not come back from the gateway with a body, so it reports nothing about
		// the budget and must not clear a standing condition.
		if (typeof status !== "number" || status < 200 || status > 299) return false;
		return this.#applySuccess(observation.key, headers, at);
	}

	/**
	 * Returns the state to fold into, discarding a state that belongs to a
	 * different key, and refusing an observation older than the one already
	 * held so out-of-order completions of parallel requests cannot roll the
	 * display backwards.
	 */
	#target(key: GatewayQuotaKey, at: number): GatewayQuotaState | null {
		const current = this.#state;
		if (current && sameKey(current.key, key)) {
			if (at < current.observedAt) return null;
			return { ...current, observedAt: at };
		}
		return { key: freezeKey(key), observedAt: at };
	}

	#applySuccess(key: GatewayQuotaKey, headers: Map<string, string>, at: number): boolean {
		const limit = parseCount(headers.get(HEADER_DAILY_LIMIT));
		const remaining = parseCount(headers.get(HEADER_DAILY_REMAINING));
		const resetAt = parseResetInstant(headers.get(HEADER_DAILY_RESET));
		const queuedMs = parseCount(headers.get(HEADER_QUEUED_MS));
		if (limit === undefined && remaining === undefined && resetAt === undefined && queuedMs === undefined) {
			return false;
		}
		const next = this.#target(key, at);
		if (!next) return false;
		if (limit !== undefined) next.limit = limit;
		if (remaining !== undefined) next.remaining = remaining;
		if (resetAt !== undefined) next.resetAt = resetAt;
		if (queuedMs !== undefined) next.lastQueuedMs = queuedMs;
		// The gateway served this request, so neither prior condition still holds.
		next.busy = undefined;
		next.exhausted = undefined;
		this.#state = next;
		return true;
	}

	#applyExhausted(key: GatewayQuotaKey, headers: Map<string, string>, at: number): boolean {
		const limit = parseCount(headers.get(HEADER_DAILY_LIMIT));
		const used = parseCount(headers.get(HEADER_DAILY_USED));
		const resetAt = parseResetInstant(headers.get(HEADER_DAILY_RESET));
		if (limit === undefined && used === undefined && resetAt === undefined) return false;
		const next = this.#target(key, at);
		if (!next) return false;
		if (limit !== undefined) next.limit = limit;
		if (resetAt !== undefined) next.resetAt = resetAt;
		const exhausted: GatewayExhaustedState = {};
		if (used !== undefined) exhausted.used = used;
		if (limit !== undefined) exhausted.limit = limit;
		const effectiveReset = resetAt ?? next.resetAt;
		if (effectiveReset !== undefined) exhausted.resetAt = effectiveReset;
		next.exhausted = exhausted;
		// The budget is spent, not the queue: a stale congestion note would
		// misattribute the rejection.
		next.busy = undefined;
		// `remaining` is only ever a gateway-reported value; the 429 says the
		// budget is gone but reports `used`, so drop the stale sample instead of
		// synthesizing a zero.
		next.remaining = undefined;
		this.#state = next;
		return true;
	}

	#applyBusy(key: GatewayQuotaKey, headers: Map<string, string>, at: number): boolean {
		const queueDepth = parseCount(headers.get(HEADER_QUEUE_DEPTH));
		const inflight = parseCount(headers.get(HEADER_INFLIGHT));
		if (queueDepth === undefined && inflight === undefined) return false;
		const next = this.#target(key, at);
		if (!next) return false;
		const busy: GatewayBusyState = { code: 503 };
		if (queueDepth !== undefined) busy.queueDepth = queueDepth;
		if (inflight !== undefined) busy.inflight = inflight;
		const retryAfterMs = parseRetryAfterMs(headers.get(HEADER_RETRY_AFTER), at);
		if (retryAfterMs !== undefined) busy.retryAfterMs = retryAfterMs;
		next.busy = busy;
		// Congestion says nothing about the token budget, so a prior exhaustion
		// must not survive as if it were still the reason requests fail.
		next.exhausted = undefined;
		this.#state = next;
		return true;
	}
}

/**
 * Countdown to a reset instant that is still ahead.
 *
 * A reset instant that has passed produces nothing. Clamping the countdown at
 * zero instead would leave an idle session showing `(0m)` indefinitely, which
 * reads as "resets any moment now" long after the reset actually happened.
 * Whether the budget refilled is not something the client can know without
 * asking the gateway, and it never asks; the next response says.
 */
function resetWindow(resetAt: number | undefined, now: number): Pick<GatewayUsageWindow, "resetValue" | "resetUnit"> {
	if (resetAt === undefined || resetAt <= now) return {};
	return { resetValue: Math.round((resetAt - now) / 60_000), resetUnit: "m" };
}

/** Whether a reported reset instant is known to have already passed. */
function resetHasPassed(resetAt: number | undefined, now: number): boolean {
	return resetAt !== undefined && resetAt <= now;
}

/**
 * Project observed state onto a status-line usage window.
 *
 * Returns `null` when there is nothing the gateway actually reported, so a
 * provider that never sent a quota header contributes no window at all rather
 * than an empty or zeroed one.
 *
 * `lastQueuedMs` is deliberately not projected. It is how long the *previous*
 * request waited for a slot, and there is no header describing the current
 * request's position or wait, so rendering it beside a live status line would
 * read as an ETA the gateway never promised.
 */
export function gatewayQuotaWindow(state: GatewayQuotaState | null, now = Date.now()): GatewayUsageWindow | null {
	if (!state) return null;
	const label = GATEWAY_LABEL;

	if (state.exhausted) {
		const exhaustedResetAt = state.exhausted.resetAt ?? state.resetAt;
		// Past its own reset instant the rejection describes a budget window that
		// has closed, so it is no longer evidence of anything. Report nothing and
		// let the next response re-establish the state, rather than keep asserting
		// a limit the gateway may well have lifted.
		if (!resetHasPassed(exhaustedResetAt, now)) {
			const limit = state.exhausted.limit ?? state.limit;
			const used = state.exhausted.used;
			const percent =
				limit !== undefined && limit > 0 && used !== undefined
					? Math.max(0, Math.min(100, (used / limit) * 100))
					: limit !== undefined && limit > 0
						? 100
						: undefined;
			return {
				label,
				...(percent !== undefined ? { percent } : {}),
				...resetWindow(exhaustedResetAt, now),
				note: "limit reached",
			};
		}
		return null;
	}

	const percent = usedPercent(state);
	if (state.busy) {
		const depth = state.busy.queueDepth;
		return {
			label,
			...(percent !== undefined ? { percent } : {}),
			...resetWindow(state.resetAt, now),
			note: depth === undefined ? "busy" : `busy queue ${depth}`,
		};
	}

	if (percent === undefined) return null;
	return { label, percent, ...resetWindow(state.resetAt, now) };
}

/**
 * Used share of the current quota window's budget. Requires both halves of
 * the pair: a lone
 * `limit` or a lone `remaining` describes no percentage, and picking one would
 * be inventing the other.
 */
function usedPercent(state: GatewayQuotaState): number | undefined {
	const { limit, remaining } = state;
	if (limit === undefined || remaining === undefined || limit <= 0) return undefined;
	const used = Math.max(0, Math.min(limit, limit - remaining));
	return (used / limit) * 100;
}
