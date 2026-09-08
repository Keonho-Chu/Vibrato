/**
 * Connect-in-one-screen support for an OpenAI-compatible LLM endpoint.
 *
 * The endpoint is usually NOT on loopback — a GPU box on the LAN is the common
 * case — so the entry point is a single URL field that accepts `host:port`
 * shorthand, and loopback discovery is only an extra convenience on the same
 * screen. Everything here is pure logic: no TUI, no prompts, no throwing.
 *
 * The probe also reports whether a gateway answered, read from the model-list
 * response the screen already fetches and from nothing else. There is no
 * identity or usage endpoint to ask, and asking would cost either an extra round
 * trip or, in the case of a completion, tokens from the very budget in question.
 */
import type { AuthStorage } from "../session/auth-storage";
import {
	fingerprintCredential,
	GatewayQuotaObserver,
	type GatewayQuotaState,
	hasGatewayQuotaHeaders,
} from "../session/gateway-quota-observer";
import { addApiCompatibleProvider, isLocalHttpHost, type ProviderSetupResult } from "./provider-onboarding";

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 700;
const MAX_MODELS_RESPONSE_BYTES = 1_000_000;

/** `scheme://` — a bare `gpu-box:8000` must NOT read as the scheme `gpu-box:`. */
const EXPLICIT_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export interface LocalEndpointModel {
	id: string;
	contextLength?: number;
}

/**
 * Token budget the gateway reported about the probing key, when it reported one
 * at all. Every field is optional because the gateway sends what it has and the
 * client invents nothing; `resetAt` in particular exists only when an
 * unambiguous instant was sent. The window these figures describe is the
 * gateway's own, configurable one — never assume a day or a midnight boundary.
 */
export interface LocalEndpointQuota {
	limit?: number;
	remaining?: number;
	used?: number;
	resetAt?: number;
}

/**
 * What a server in front of the endpoint said about itself on the model list.
 *
 * Both signals are structural and belong to the gateway alone: the `x-vug-*`
 * response headers the quota observer already knows, and the `vibrato` object a
 * Vibrato-aware server attaches to its models-list entries (see
 * "Server-advertised model hints" in `docs/models.md`). Neither the URL nor the
 * provider name is consulted, so a plain vLLM, SGLang, Ollama, or llama.cpp
 * endpoint never reads as a gateway.
 */
export interface LocalEndpointGateway {
	/** Model entries carrying the server's own `vibrato` hint object. */
	hintedModels: number;
	/** Only present when the model-list response actually carried quota headers. */
	quota?: LocalEndpointQuota;
}

export type LocalEndpointProbe =
	| { status: "ok"; models: LocalEndpointModel[]; gateway?: LocalEndpointGateway }
	| { status: "unauthorized" }
	/** The key is valid, but its budget for the gateway's current window is spent. */
	| { status: "quota-exhausted"; quota: LocalEndpointQuota }
	| { status: "no-models" }
	| { status: "unreachable"; detail: string };

export interface DiscoveredLocalEndpoint {
	baseUrl: string;
	label: string;
	models: LocalEndpointModel[];
	gateway?: LocalEndpointGateway;
}

export interface LocalEndpointProbeOptions {
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

/**
 * Turn whatever the user typed into a base URL the registry accepts.
 *
 * Accepts `192.168.0.10:8000`, `gpu-box:8000`, `http://host:8000/v1`, and
 * trailing slashes. The scheme is inferred when missing: plain http for the
 * hosts {@link isLocalHttpHost} recognizes as local, https otherwise. An
 * explicit scheme is kept as typed: someone who writes `http://` for a host
 * outside the well-known private ranges (a corporate network on public-range
 * addresses, say) knows their server better than the heuristic does. `/v1` is
 * appended only when no path was given.
 */
export function normalizeLocalEndpointInput(raw: string): { baseUrl: string } | { error: string } {
	const trimmed = raw.trim();
	if (!trimmed) {
		return { error: "Enter a server address, for example 192.168.0.10:8000." };
	}

	let url: URL;
	try {
		url = EXPLICIT_SCHEME.test(trimmed) ? new URL(trimmed) : new URL(`${inferScheme(trimmed)}://${trimmed}`);
	} catch {
		return { error: `'${trimmed}' is not a valid server address.` };
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { error: "The address must use http:// or https://." };
	}
	if (!url.hostname) {
		return { error: `'${trimmed}' is missing a host name.` };
	}

	// A query string or fragment cannot survive `${baseUrl}/models`, so drop both.
	const path = url.pathname.replace(/\/+$/, "");
	const credentials = url.username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
	return { baseUrl: `${url.protocol}//${credentials}${url.host}${path || "/v1"}` };
}

/** Plain http is inferred only for hosts that are recognizably local; everything else gets https. */
function inferScheme(hostAndRest: string): "http" | "https" {
	let hostname: string;
	try {
		hostname = new URL(`http://${hostAndRest}`).hostname;
	} catch {
		// Let the caller's own parse produce the error message.
		return "http";
	}
	return isLocalHttpHost(hostname) ? "http" : "https";
}

/**
 * `GET ${baseUrl}/models`, mapped to the four outcomes the connect screen acts
 * on. Never throws: a network failure, a timeout, and a malformed body all come
 * back as `unreachable`.
 */
export async function probeLocalEndpoint(
	baseUrl: string,
	apiKey?: string,
	options?: LocalEndpointProbeOptions,
): Promise<LocalEndpointProbe> {
	const fetchImpl = options?.fetchImpl ?? fetch;
	const timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const key = apiKey?.trim();
	const headers: Record<string, string> = { Accept: "application/json" };
	if (key) headers.Authorization = `Bearer ${key}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let response: Response;
	try {
		response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
			method: "GET",
			headers,
			signal: controller.signal,
		});
	} catch (error) {
		return { status: "unreachable", detail: describeProbeFailure(error, controller.signal, timeoutMs) };
	} finally {
		clearTimeout(timer);
	}

	if (response.status === 401 || response.status === 403) return { status: "unauthorized" };
	// A gateway checks the key's budget before it routes anything, so even this
	// model list comes back 429 once the budget is spent. Read as a bare HTTP
	// error it looked like an unreachable server; the headers say plainly that
	// the key is good and only the allowance is gone. A 429 without them is some
	// other server's throttle and keeps the generic path.
	if (response.status === 429) {
		const exhausted = observeGatewayQuota(baseUrl, key, response, "failure")?.exhausted;
		if (exhausted) return { status: "quota-exhausted", quota: toLocalEndpointQuota(exhausted) };
	}
	if (!response.ok) {
		return {
			status: "unreachable",
			detail: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
		};
	}

	let payload: unknown;
	try {
		const text = await response.text();
		if (text.length > MAX_MODELS_RESPONSE_BYTES) {
			return { status: "unreachable", detail: "the model list response was too large" };
		}
		payload = JSON.parse(text);
	} catch {
		return { status: "unreachable", detail: "the server did not return JSON" };
	}

	const entries = extractModelEntries(payload);
	if (!entries) {
		return { status: "unreachable", detail: "the server did not return an OpenAI-compatible model list" };
	}
	const models = toLocalEndpointModels(entries);
	if (models.length === 0) return { status: "no-models" };
	const gateway = readGatewaySignals(baseUrl, key, response, entries);
	return { status: "ok", models, ...(gateway ? { gateway } : {}) };
}

/** Session id for the throwaway observer below; it never outlives one probe. */
const PROBE_OBSERVER_SESSION = "local-endpoint-probe";

/**
 * Fold one probe response through the session's own quota observer, so the
 * `x-vug-*` names and their accepted formats are read in exactly one place. The
 * observer is created per call and discarded with the state it produced: it
 * exists here only as a parser, never as the session-long store it is on the
 * request path.
 */
function observeGatewayQuota(
	baseUrl: string,
	apiKey: string | undefined,
	response: Response,
	kind: "success" | "failure",
): GatewayQuotaState | null {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, name) => {
		headers[name.toLowerCase()] = value;
	});
	// Cheap and allocation-free, and it keeps the credential digest below off the
	// path of every ordinary endpoint that has nothing to do with a gateway.
	if (!hasGatewayQuotaHeaders(headers)) return null;
	const observer = new GatewayQuotaObserver();
	observer.observe({
		key: {
			provider: "local",
			baseUrl,
			credentialId: fingerprintCredential(apiKey, PROBE_OBSERVER_SESSION),
			sessionId: PROBE_OBSERVER_SESSION,
		},
		kind,
		status: response.status,
		headers,
	});
	return observer.state;
}

function toLocalEndpointQuota(source: {
	limit?: number;
	remaining?: number;
	used?: number;
	resetAt?: number;
}): LocalEndpointQuota {
	return {
		...(source.limit !== undefined ? { limit: source.limit } : {}),
		...(source.remaining !== undefined ? { remaining: source.remaining } : {}),
		...(source.used !== undefined ? { used: source.used } : {}),
		...(source.resetAt !== undefined ? { resetAt: source.resetAt } : {}),
	};
}

/**
 * Decide whether a gateway answered, from the response alone. Returns undefined
 * for every endpoint that showed neither signal, which is what keeps the connect
 * screen's existing flow untouched for a plain server.
 */
function readGatewaySignals(
	baseUrl: string,
	apiKey: string | undefined,
	response: Response,
	entries: readonly Record<string, unknown>[],
): LocalEndpointGateway | undefined {
	const hintedModels = entries.filter(entry => isRecord(entry.vibrato)).length;
	const state = observeGatewayQuota(baseUrl, apiKey, response, "success");
	const quota = state ? toLocalEndpointQuota(state) : undefined;
	// An observed state with no field set is not evidence of anything.
	const reportedQuota = quota && Object.keys(quota).length > 0 ? quota : undefined;
	if (hintedModels === 0 && !reportedQuota) return undefined;
	return { hintedModels, ...(reportedQuota ? { quota: reportedQuota } : {}) };
}

function describeProbeFailure(error: unknown, signal: AbortSignal, timeoutMs: number): string {
	if (signal.aborted) return `no response within ${timeoutMs} ms`;
	const message = error instanceof Error ? error.message : String(error);
	return message.trim() || "the server could not be reached";
}

function extractModelEntries(payload: unknown): Record<string, unknown>[] | undefined {
	const list = Array.isArray(payload)
		? payload
		: isRecord(payload) && Array.isArray(payload.data)
			? payload.data
			: undefined;
	return list?.filter(isRecord);
}

function toLocalEndpointModels(entries: readonly Record<string, unknown>[]): LocalEndpointModel[] {
	const models = new Map<string, LocalEndpointModel>();
	for (const entry of entries) {
		const id = typeof entry.id === "string" ? entry.id.trim() : "";
		if (!id || models.has(id)) continue;
		const contextLength = readContextLength(entry);
		models.set(id, contextLength === undefined ? { id } : { id, contextLength });
	}
	return [...models.values()];
}

/**
 * Mirrors the fields the OpenAI-compatible discovery path already reads
 * (`packages/ai/src/utils/discovery/openai-compatible.ts` and
 * `packages/ai/src/provider-models/openai-compat.ts`), whose helpers are
 * module-private. `max_model_len` comes first because vLLM reports the real
 * served window there.
 */
function readContextLength(entry: Record<string, unknown>): number | undefined {
	return firstPositiveNumber(
		entry.max_model_len,
		entry.context_length,
		entry.context_window,
		entry.max_context_length,
		entry.max_position_embeddings,
		nested(entry, ["details", "context_length"]),
		nested(entry, ["details", "n_ctx"]),
		nested(entry, ["meta", "n_ctx"]),
		nested(entry, ["meta", "n_ctx_train"]),
		entry.max_completion_tokens,
		nested(entry, ["details", "max_completion_tokens"]),
		nested(entry, ["meta", "max_completion_tokens"]),
	);
}

function nested(entry: Record<string, unknown>, path: readonly string[]): unknown {
	let current: unknown = entry;
	for (const segment of path) {
		if (!isRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function firstPositiveNumber(...candidates: readonly unknown[]): number | undefined {
	for (const candidate of candidates) {
		const value =
			typeof candidate === "number"
				? candidate
				: typeof candidate === "string" && candidate.trim()
					? Number(candidate)
					: Number.NaN;
		if (Number.isFinite(value) && value > 0) return value;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface LoopbackCandidate {
	label: string;
	defaultBaseUrl: string;
	envNames: readonly string[];
}

/**
 * Ports match the implicit providers the registry already assumes
 * (`#addImplicitDiscoverableProviders` in `config/model-registry.ts`).
 * llama.cpp and oMLX share port 8080, so they share one row.
 */
const LOOPBACK_CANDIDATES: readonly LoopbackCandidate[] = [
	{ label: "Ollama", defaultBaseUrl: "http://127.0.0.1:11434/v1", envNames: ["OLLAMA_BASE_URL"] },
	{ label: "LM Studio", defaultBaseUrl: "http://127.0.0.1:1234/v1", envNames: ["LM_STUDIO_BASE_URL"] },
	{
		label: "llama.cpp / oMLX",
		defaultBaseUrl: "http://127.0.0.1:8080/v1",
		envNames: ["LLAMA_CPP_BASE_URL", "OMLX_BASE_URL"],
	},
	{ label: "vLLM", defaultBaseUrl: "http://127.0.0.1:8000/v1", envNames: ["VLLM_BASE_URL"] },
	{ label: "SGLang", defaultBaseUrl: "http://127.0.0.1:30000/v1", envNames: ["SGLANG_BASE_URL"] },
];

/**
 * Probe the well-known local servers at once and return the ones that actually
 * serve a model. Safe to call at startup: every probe runs concurrently, so the
 * wall time is one timeout regardless of how many candidates there are.
 */
export async function discoverLoopbackEndpoints(
	options?: LocalEndpointProbeOptions,
): Promise<DiscoveredLocalEndpoint[]> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
	const targets = new Map<string, string>();
	for (const candidate of LOOPBACK_CANDIDATES) {
		for (const baseUrl of resolveCandidateBaseUrls(candidate)) {
			if (!targets.has(baseUrl)) targets.set(baseUrl, candidate.label);
		}
	}

	const probes = [...targets].map(async ([baseUrl, label]) => {
		const probe = await probeLocalEndpoint(baseUrl, undefined, { timeoutMs, fetchImpl: options?.fetchImpl });
		if (probe.status !== "ok" || probe.models.length === 0) return undefined;
		return { baseUrl, label, models: probe.models, ...(probe.gateway ? { gateway: probe.gateway } : {}) };
	});
	const settled = await Promise.all(probes);
	return settled.filter((entry): entry is DiscoveredLocalEndpoint => entry !== undefined);
}

function resolveCandidateBaseUrls(candidate: LoopbackCandidate): string[] {
	const fromEnv: string[] = [];
	for (const name of candidate.envNames) {
		const raw = Bun.env[name]?.trim();
		if (!raw) continue;
		const normalized = normalizeLocalEndpointInput(raw);
		if ("baseUrl" in normalized) fromEnv.push(normalized.baseUrl);
	}
	if (fromEnv.length > 0) return fromEnv;
	const fallback = normalizeLocalEndpointInput(candidate.defaultBaseUrl);
	return "baseUrl" in fallback ? [fallback.baseUrl] : [];
}

/**
 * Write the endpoint to `models.yml` through the existing `local` preset, so a
 * keyless endpoint gets the same optional-credential `openaiCompat` entry the
 * CLI path writes. Replaces an existing `local` provider: reconnecting to a
 * different box is the whole point of the screen.
 *
 * A key never lands in `models.yml`; it is stored as a credential. From inside
 * a running session pass that session's `authStorage`, or the session keeps
 * treating the endpoint as unauthenticated until the next start.
 */
export async function registerLocalEndpoint(input: {
	baseUrl: string;
	apiKey?: string;
	authStorage?: AuthStorage;
}): Promise<ProviderSetupResult> {
	const apiKey = input.apiKey?.trim();
	return addApiCompatibleProvider({
		preset: "local",
		baseUrl: input.baseUrl,
		...(apiKey ? { apiKey } : {}),
		...(input.authStorage ? { authStorage: input.authStorage } : {}),
		force: true,
	});
}

/**
 * The inline error for an endpoint that was registered but is not usable. The
 * screen has already proved the key against the server, so a discovery that
 * ends anywhere but `ok` means the credential did not reach the session, or the
 * server changed its answer between the probe and the refresh.
 */
export function describeUnusableEndpoint(
	providerId: string,
	state: { status: string; error?: string } | undefined,
): string {
	if (!state || state.status === "unauthenticated") {
		return `The API key for '${providerId}' was not saved, so the endpoint would be used without it. Try connecting again.`;
	}
	if (state.status === "empty") return `'${providerId}' listed no models after setup.`;
	const detail = state.error ? `: ${state.error}` : ".";
	return `'${providerId}' could not list its models after setup${detail}`;
}
