/**
 * Connect-in-one-screen support for an OpenAI-compatible LLM endpoint.
 *
 * The endpoint is usually NOT on loopback — a GPU box on the LAN is the common
 * case — so the entry point is a single URL field that accepts `host:port`
 * shorthand, and loopback discovery is only an extra convenience on the same
 * screen. Everything here is pure logic: no TUI, no prompts, no throwing.
 */
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

export type LocalEndpointProbe =
	| { status: "ok"; models: LocalEndpointModel[] }
	| { status: "unauthorized" }
	| { status: "no-models" }
	| { status: "unreachable"; detail: string };

export interface DiscoveredLocalEndpoint {
	baseUrl: string;
	label: string;
	models: LocalEndpointModel[];
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
 * hosts that {@link isLocalHttpHost} allows it for, https otherwise. `/v1` is
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
	if (url.protocol === "http:" && !isLocalHttpHost(url.hostname)) {
		return {
			error: `Plain http is only accepted for localhost or a private-network host; use https:// for ${url.hostname}.`,
		};
	}

	// A query string or fragment cannot survive `${baseUrl}/models`, so drop both.
	const path = url.pathname.replace(/\/+$/, "");
	const credentials = url.username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
	return { baseUrl: `${url.protocol}//${credentials}${url.host}${path || "/v1"}` };
}

/** Plain http is inferred only where it is also accepted; everything else gets https. */
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
	return models.length > 0 ? { status: "ok", models } : { status: "no-models" };
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
		return probe.status === "ok" && probe.models.length > 0 ? { baseUrl, label, models: probe.models } : undefined;
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
 */
export async function registerLocalEndpoint(input: { baseUrl: string; apiKey?: string }): Promise<ProviderSetupResult> {
	const apiKey = input.apiKey?.trim();
	return addApiCompatibleProvider({
		preset: "local",
		baseUrl: input.baseUrl,
		...(apiKey ? { apiKey } : {}),
		force: true,
	});
}
