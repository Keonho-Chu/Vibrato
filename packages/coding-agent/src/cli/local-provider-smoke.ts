import chalk from "chalk";
import {
	findProvidersWithEmptyApiKeyEnv,
	type HiddenProviderApiKeyEnv,
	ModelsConfigFile,
} from "../config/model-registry";
import type { ModelsConfig } from "../config/models-config-schema";
import {
	fingerprintCredential,
	type GatewayQuotaKey,
	GatewayQuotaObserver,
	type GatewayQuotaState,
	hasGatewayQuotaHeaders,
} from "../session/gateway-quota-observer";

export interface LocalProviderSmokeCommandArgs {
	model?: string;
	modelsPath?: string;
	timeoutMs?: number;
	json?: boolean;
	smoke?: boolean;
}

export interface LocalOpenAICompatConfig {
	baseUrl: string;
	apiKey?: string;
}

export type LocalProviderDiagnosticCheckName = "config" | "models" | "chat_stream";
export type LocalProviderDiagnosticStatus = "ok" | "skipped" | "error";
export type LocalProviderDiagnosticCategory =
	| "auth"
	| "timeout"
	| "unreachable"
	| "not_ready"
	| "oom"
	| "malformed_response"
	| "http_error"
	| "configuration"
	| "empty_response"
	/** The usage gateway refused the request: this key's token budget is spent. */
	| "token_limit"
	/** The usage gateway refused the request: no upstream slot was free in time. */
	| "gateway_busy";

/**
 * What the usage gateway reported about this key on the smoke request's own
 * response.
 *
 * Every field comes from a header the gateway actually sent, parsed by
 * `gateway-quota-observer`. Nothing is derived except `used`, which is the
 * difference of two reported numbers. An endpoint that is not behind the
 * gateway sends none of these headers and produces no facts at all.
 *
 * The header names say "daily", but the window they describe is whatever the
 * operator configured, so nothing here is phrased as a day.
 */
export interface LocalProviderGatewayFacts {
	/** Token budget for this key in the current quota window. */
	limit?: number;
	/** Tokens charged so far in the window. Reported on a refusal, derived from `limit - remaining` otherwise. */
	used?: number;
	/** Budget left when the request was admitted. A past sample, not a live balance. */
	remaining?: number;
	/** Reset instant, ISO-8601. Present only when the gateway sent an unambiguous one. */
	resetAt?: string;
	/** Milliseconds until `resetAt`. Absent once the instant has passed. */
	resetInMs?: number;
	/** Requests waiting for an upstream slot when the gateway refused this one. */
	queueDepth?: number;
	/** Requests in flight upstream at that moment. */
	inflight?: number;
	/** How long this request waited for a slot before it was served. */
	queuedMs?: number;
	/** How long the gateway asked the client to wait, when it refused. */
	retryAfterMs?: number;
}

export interface LocalProviderDiagnosticCheck {
	name: LocalProviderDiagnosticCheckName;
	status: LocalProviderDiagnosticStatus;
	message: string;
	action?: string;
	category?: LocalProviderDiagnosticCategory;
	error?: string;
	httpStatus?: number;
}

export interface LocalProviderSmokeResult {
	ok: boolean;
	baseUrl?: string;
	model?: string;
	message: string;
	error?: string;
	category?: LocalProviderDiagnosticCategory;
	action?: string;
	/** Present only when a chat request was made and the endpoint answered as the gateway. */
	gateway?: LocalProviderGatewayFacts;
}

export interface LocalProviderDiscoveryResult {
	ok: boolean;
	provider: string;
	baseUrl?: string;
	models: string[];
	message: string;
	error?: string;
	category?: LocalProviderDiagnosticCategory;
	action?: string;
}

export interface LocalProviderStatusResult {
	ok: boolean;
	provider: "local";
	baseUrl?: string;
	model?: string;
	models: string[];
	checks: LocalProviderDiagnosticCheck[];
	message: string;
	/** Present only when a chat request was made and the endpoint answered as the gateway. */
	gateway?: LocalProviderGatewayFacts;
	/**
	 * Providers whose models are hidden because the environment variable named
	 * by their `apiKeyEnv` is unset or empty. Reported for every provider in
	 * `models.yml`, not just the local one, because a hidden provider is the
	 * usual reason the model list looks empty.
	 */
	hiddenProviders: HiddenProviderApiKeyEnv[];
}

interface ClassifiedFailure {
	category: LocalProviderDiagnosticCategory;
	message: string;
	action: string;
	error?: string;
	httpStatus?: number;
}

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_SMOKE_PROMPT = "Reply with ok.";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function resolveApiKey(apiKey: string | undefined, apiKeyEnv: string | undefined): string | undefined {
	if (apiKeyEnv) return Bun.env[apiKeyEnv];
	if (!apiKey) return undefined;
	return Bun.env[apiKey] ?? apiKey;
}

function normalizeOpenAICompatBaseUrl(baseUrl: string): string {
	try {
		const parsed = new URL(baseUrl);
		const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
		parsed.pathname = trimmedPath.endsWith("/v1") ? trimmedPath || "/v1" : `${trimmedPath}/v1`;
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		const trimmed = baseUrl.replace(/\/+$/g, "");
		return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
	}
}

export function getLocalOpenAICompatConfig(config: ModelsConfig | undefined): LocalOpenAICompatConfig | undefined {
	const openaiCompat = config?.providers?.local?.openaiCompat;
	if (!openaiCompat?.baseUrl) return undefined;
	return {
		baseUrl: normalizeOpenAICompatBaseUrl(openaiCompat.baseUrl),
		apiKey: resolveApiKey(openaiCompat.apiKey, openaiCompat.apiKeyEnv),
	};
}

function extractModelIds(payload: unknown): string[] {
	if (!isRecord(payload)) {
		throw new Error("/models response was not a JSON object");
	}
	if (!Array.isArray(payload.data)) {
		throw new Error("/models response did not include a data array");
	}
	const models = payload.data.flatMap(item => {
		if (!isRecord(item) || typeof item.id !== "string") return [];
		const id = item.id.trim();
		return id ? [id] : [];
	});
	if (models.length === 0) {
		throw new Error("/models returned no model ids");
	}
	return [...new Set(models)].sort((left, right) => left.localeCompare(right));
}

/**
 * The parsed `models.yml` travels with both outcomes: a run that finds no local
 * endpoint must still be able to explain a provider hidden by an empty
 * `apiKeyEnv`, which is exactly the case where the local block is absent
 * because the endpoint is reached through a gateway provider instead.
 */
type LocalConfigResolution =
	| (LocalProviderSmokeResult & { modelsConfig?: ModelsConfig })
	| (LocalOpenAICompatConfig & { modelsConfig: ModelsConfig });

async function readLocalConfig(modelsPath: string | undefined): Promise<LocalConfigResolution> {
	const configFile = modelsPath ? ModelsConfigFile.relocate(modelsPath) : ModelsConfigFile;
	configFile.invalidate?.();
	const loaded = configFile.tryLoad();
	if (loaded.status === "error") {
		return {
			ok: false,
			message: "Failed to load models config.",
			error: loaded.error.message,
			category: "configuration",
			action: "Fix the models config file syntax, then retry the local-provider diagnostic.",
		};
	}
	const modelsConfig = loaded.value ?? undefined;
	const localConfig = modelsConfig ? getLocalOpenAICompatConfig(modelsConfig) : undefined;
	if (!modelsConfig || !localConfig) {
		return {
			ok: false,
			modelsConfig,
			message: `No local OpenAI-compatible endpoint configured. Add providers.local.openaiCompat.baseUrl to ${configFile.path()}.`,
			category: "configuration",
			action: "Configure providers.local.openaiCompat.baseUrl for the local server you already run.",
		};
	}
	return { ...localConfig, modelsConfig };
}

function buildHeaders(apiKey: string | undefined): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	return headers;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function responsePreview(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	return text.slice(0, 500);
}

function bodyLooksLike(text: string | undefined, needles: readonly string[]): boolean {
	const lower = (text ?? "").toLowerCase();
	return needles.some(needle => lower.includes(needle));
}

function classifyHttpFailure(context: "models" | "chat_stream", status: number, body: string): ClassifiedFailure {
	if (status === 401 || status === 403) {
		return {
			category: "auth",
			httpStatus: status,
			message: `${context === "models" ? "GET /v1/models" : "Streaming chat smoke"} authentication failed.`,
			action:
				"Check providers.local.openaiCompat.apiKey/apiKeyEnv, or remove auth if the local server does not require it.",
			error: `HTTP ${status}${body ? `: ${body}` : ""}`,
		};
	}
	if (bodyLooksLike(body, ["out of memory", "oom", "cuda out", "insufficient memory"])) {
		return {
			category: "oom",
			httpStatus: status,
			message: `${context === "models" ? "GET /v1/models" : "Streaming chat smoke"} reported an out-of-memory condition.`,
			action: "Free GPU/CPU memory, lower the model/context size, or unload another model before retrying.",
			error: `HTTP ${status}${body ? `: ${body}` : ""}`,
		};
	}
	if (
		status === 408 ||
		status === 409 ||
		status === 425 ||
		status === 429 ||
		status === 503 ||
		status === 504 ||
		bodyLooksLike(body, ["loading", "warming", "not ready", "initializing", "starting", "model is loading"])
	) {
		return {
			category: "not_ready",
			httpStatus: status,
			message: `${context === "models" ? "GET /v1/models" : "Streaming chat smoke"} reached the server, but it is not ready.`,
			action: "Wait for the local server/model load to finish, verify the selected model is loaded, then retry.",
			error: `HTTP ${status}${body ? `: ${body}` : ""}`,
		};
	}
	return {
		category: "http_error",
		httpStatus: status,
		message: `${context === "models" ? "GET /v1/models" : "Streaming chat smoke"} returned HTTP ${status}.`,
		action:
			"Check the local server logs and confirm the configured base URL points at an OpenAI-compatible /v1 endpoint.",
		error: `HTTP ${status}${body ? `: ${body}` : ""}`,
	};
}

/**
 * `error.code` the gateway sends with a 429 when this key's token budget for
 * the current quota window is spent. The name is the wire contract's; the
 * window it describes is operator-configured, so no wording derived from it may
 * claim a day.
 */
const GATEWAY_TOKEN_LIMIT_CODE = "daily_token_limit";
/** `error.code`s the gateway sends with a 503 when no upstream slot came free. */
const GATEWAY_BUSY_CODES: ReadonlySet<string> = new Set(["queue_timeout", "queue_full"]);

/** Response headers as the quota observer wants them. Header names arrive lower-cased. */
function responseHeaderRecord(response: Response): Record<string, string> {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, name) => {
		headers[name.toLowerCase()] = value;
	});
	return headers;
}

/**
 * Fold one response into the observer, but only when it carries a gateway
 * header. A plain local server's response is left alone entirely, so nothing it
 * happens to send can be read as quota state.
 */
function observeGatewayResponse(
	observer: GatewayQuotaObserver,
	key: GatewayQuotaKey,
	kind: "success" | "failure",
	response: Response,
): void {
	const headers = responseHeaderRecord(response);
	if (!hasGatewayQuotaHeaders(headers)) return;
	observer.observe({ key, kind, status: response.status, headers });
}

function gatewayObservationKey(config: LocalOpenAICompatConfig): GatewayQuotaKey {
	return {
		provider: "local",
		baseUrl: config.baseUrl,
		// This command owns one request and exits, so the scope only has to keep
		// the fingerprint away from a real session's state.
		credentialId: fingerprintCredential(config.apiKey, "local-provider"),
		sessionId: "local-provider",
	};
}

/** `2h 30m`, `45m`, `20s`. Approximate on purpose: the gateway's own reset is a whole instant, not a countdown. */
function formatApproximateDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

/**
 * Project what the observer holds onto the facts this command prints.
 *
 * `used` is the only derived number, and only when the gateway reported both
 * halves of the pair. Everything else is a value the gateway sent.
 */
function toGatewayFacts(state: GatewayQuotaState | null, now: number): LocalProviderGatewayFacts | undefined {
	if (!state) return undefined;
	const facts: LocalProviderGatewayFacts = {};
	const limit = state.exhausted?.limit ?? state.limit;
	if (limit !== undefined) facts.limit = limit;
	if (state.remaining !== undefined) facts.remaining = state.remaining;
	const used =
		state.exhausted?.used ??
		(limit !== undefined && state.remaining !== undefined ? Math.max(0, limit - state.remaining) : undefined);
	if (used !== undefined) facts.used = used;
	const resetAt = state.exhausted?.resetAt ?? state.resetAt;
	if (resetAt !== undefined) {
		facts.resetAt = new Date(resetAt).toISOString();
		// A reset instant that has already passed describes a window that closed;
		// a countdown to it would read as "any moment now" forever.
		if (resetAt > now) facts.resetInMs = resetAt - now;
	}
	if (state.busy?.queueDepth !== undefined) facts.queueDepth = state.busy.queueDepth;
	if (state.busy?.inflight !== undefined) facts.inflight = state.busy.inflight;
	if (state.busy?.retryAfterMs !== undefined) facts.retryAfterMs = state.busy.retryAfterMs;
	if (state.lastQueuedMs !== undefined) facts.queuedMs = state.lastQueuedMs;
	return Object.keys(facts).length > 0 ? facts : undefined;
}

/** `error.code` from an OpenAI-shaped error envelope, if the body is one. */
function readGatewayErrorCode(body: string): string | undefined {
	if (!body.trimStart().startsWith("{")) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		// A body longer than the preview window arrives truncated. Falling back to
		// the generic classification is the right answer: without the code there
		// is no proof this rejection is the gateway's.
		return undefined;
	}
	if (!isRecord(parsed) || !isRecord(parsed.error)) return undefined;
	const code = parsed.error.code;
	return typeof code === "string" ? code : undefined;
}

/**
 * The gateway's own two rejections, told apart by the `error.code` it promises
 * rather than by the status alone — an ordinary local server also answers 429
 * and 503, and those keep the existing `not_ready` wording.
 */
function classifyGatewayRejection(
	status: number,
	body: string,
	state: GatewayQuotaState | null,
	now: number,
): ClassifiedFailure | undefined {
	const code = readGatewayErrorCode(body);
	if (!code) return undefined;
	if (status === 429 && code === GATEWAY_TOKEN_LIMIT_CODE) {
		// The observer records the reset instant a 429 carries but not its
		// Retry-After, and the gateway always sends the instant on this rejection,
		// so the countdown comes from the instant or is omitted.
		const resetAt = state?.exhausted?.resetAt ?? state?.resetAt;
		const resetsIn =
			resetAt !== undefined && resetAt > now ? `; resets in ${formatApproximateDuration(resetAt - now)}` : "";
		return {
			category: "token_limit",
			httpStatus: status,
			message: `Streaming chat smoke was refused by the usage gateway: token limit reached${resetsIn}.`,
			action: "Wait for the quota window to reset, or ask the gateway operator to raise this key's token limit.",
			error: `HTTP ${status}${body ? `: ${body}` : ""}`,
		};
	}
	if (status === 503 && GATEWAY_BUSY_CODES.has(code)) {
		const depth = state?.busy?.queueDepth;
		const retryAfterMs = state?.busy?.retryAfterMs;
		return {
			category: "gateway_busy",
			httpStatus: status,
			message: `Streaming chat smoke was refused by the usage gateway: gateway busy${depth === undefined ? "" : ` (queue ${depth})`}.`,
			action:
				retryAfterMs === undefined
					? "Retry once the gateway has a free upstream slot."
					: `Retry in ${formatApproximateDuration(retryAfterMs)}, once the gateway has a free upstream slot.`,
			error: `HTTP ${status}${body ? `: ${body}` : ""}`,
		};
	}
	return undefined;
}

function classifyThrownFailure(
	context: "models" | "chat_stream",
	error: unknown,
	timeoutMs: number,
): ClassifiedFailure {
	const message = toErrorMessage(error);
	const name = error instanceof Error ? error.name : "";
	if (name === "AbortError" || name === "TimeoutError" || message.toLowerCase().includes("abort")) {
		return {
			category: "timeout",
			message: `${context === "models" ? "GET /v1/models" : "Streaming chat smoke"} timed out after ${timeoutMs}ms.`,
			action:
				"Confirm the local server is running and responsive; if it is loading a model, retry after it is ready or pass a slightly larger --timeout-ms.",
			error: message,
		};
	}
	if (
		bodyLooksLike(message, [
			"connection refused",
			"econnrefused",
			"couldn't connect",
			"failed to connect",
			"connection reset",
			"enotfound",
			"fetch failed",
		])
	) {
		return {
			category: "unreachable",
			message: `${context === "models" ? "GET /v1/models" : "Streaming chat smoke"} could not reach the configured endpoint.`,
			action:
				"Start the local OpenAI-compatible server or update providers.local.openaiCompat.baseUrl to the listening host/port.",
			error: message,
		};
	}
	if (bodyLooksLike(message, ["out of memory", "oom", "cuda out", "insufficient memory"])) {
		return {
			category: "oom",
			message: `${context === "models" ? "GET /v1/models" : "Streaming chat smoke"} reported an out-of-memory condition.`,
			action: "Free GPU/CPU memory, lower the model/context size, or unload another model before retrying.",
			error: message,
		};
	}
	return {
		category: "http_error",
		message: `${context === "models" ? "GET /v1/models" : "Streaming chat smoke"} failed.`,
		action: "Check the local server logs and retry the diagnostic after the endpoint is healthy.",
		error: message,
	};
}

function malformedFailure(error: unknown): ClassifiedFailure {
	return {
		category: "malformed_response",
		message: "GET /v1/models returned a malformed OpenAI-compatible response.",
		action:
			"Confirm the endpoint serves OpenAI-compatible JSON shaped like { data: [{ id: string }] } at /v1/models.",
		error: toErrorMessage(error),
	};
}

async function fetchLocalModelIds(config: LocalOpenAICompatConfig, timeoutMs: number): Promise<string[]> {
	const response = await fetch(`${config.baseUrl}/models`, {
		headers: buildHeaders(config.apiKey),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) {
		const body = await responsePreview(response);
		throw new Error(classifyHttpFailure("models", response.status, body).error);
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new Error(`Failed to parse /models JSON: ${toErrorMessage(error)}`);
	}
	return extractModelIds(payload);
}

async function diagnoseLocalModels(
	config: LocalOpenAICompatConfig,
	timeoutMs: number,
): Promise<{ models: string[]; check: LocalProviderDiagnosticCheck }> {
	try {
		const response = await fetch(`${config.baseUrl}/models`, {
			headers: buildHeaders(config.apiKey),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			const body = await responsePreview(response);
			const failure = classifyHttpFailure("models", response.status, body);
			return { models: [], check: { name: "models", status: "error", ...failure } };
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			const failure = malformedFailure(new Error(`Failed to parse /models JSON: ${toErrorMessage(error)}`));
			return { models: [], check: { name: "models", status: "error", ...failure } };
		}
		try {
			const models = extractModelIds(payload);
			return {
				models,
				check: {
					name: "models",
					status: "ok",
					message: `GET /v1/models succeeded and returned ${models.length} model${models.length === 1 ? "" : "s"}.`,
				},
			};
		} catch (error) {
			const failure = malformedFailure(error);
			return { models: [], check: { name: "models", status: "error", ...failure } };
		}
	} catch (error) {
		const failure = classifyThrownFailure("models", error, timeoutMs);
		return { models: [], check: { name: "models", status: "error", ...failure } };
	}
}

async function discoverFirstModel(config: LocalOpenAICompatConfig, timeoutMs: number): Promise<string> {
	try {
		return (await fetchLocalModelIds(config, timeoutMs))[0]!;
	} catch (error) {
		const message = toErrorMessage(error);
		if (message === "/models returned no model ids") {
			throw new Error("/models returned no model ids; pass --model explicitly");
		}
		throw error;
	}
}

async function readStreamingBody(response: Response): Promise<number> {
	if (!response.body) return 0;
	const reader = response.body.getReader();
	let chunks = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value.byteLength > 0) chunks += 1;
		}
	} finally {
		reader.releaseLock();
	}
	return chunks;
}

async function diagnoseChatStream(
	config: LocalOpenAICompatConfig,
	model: string,
	timeoutMs: number,
	observer: GatewayQuotaObserver,
): Promise<LocalProviderDiagnosticCheck> {
	const observationKey = gatewayObservationKey(config);
	try {
		const response = await fetch(`${config.baseUrl}/chat/completions`, {
			method: "POST",
			headers: buildHeaders(config.apiKey),
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: DEFAULT_SMOKE_PROMPT }],
				stream: true,
				max_tokens: 16,
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			observeGatewayResponse(observer, observationKey, "failure", response);
			const body = await responsePreview(response);
			const failure =
				classifyGatewayRejection(response.status, body, observer.state, Date.now()) ??
				classifyHttpFailure("chat_stream", response.status, body);
			return { name: "chat_stream", status: "error", ...failure };
		}
		observeGatewayResponse(observer, observationKey, "success", response);
		const chunks = await readStreamingBody(response);
		if (chunks === 0) {
			return {
				name: "chat_stream",
				status: "error",
				category: "empty_response",
				message: "Streaming chat smoke reached the server but returned no body chunks.",
				action:
					"Check whether the selected model supports streaming chat completions and inspect the local server logs.",
			};
		}
		return {
			name: "chat_stream",
			status: "ok",
			message: `Streaming chat smoke succeeded for ${model} (${chunks} chunk${chunks === 1 ? "" : "s"}).`,
		};
	} catch (error) {
		const failure = classifyThrownFailure("chat_stream", error, timeoutMs);
		return { name: "chat_stream", status: "error", ...failure };
	}
}

export async function runLocalProviderDiscover(
	cmd: Omit<LocalProviderSmokeCommandArgs, "model" | "smoke">,
): Promise<LocalProviderDiscoveryResult> {
	const timeoutMs = cmd.timeoutMs && cmd.timeoutMs > 0 ? cmd.timeoutMs : DEFAULT_TIMEOUT_MS;
	const configResult = await readLocalConfig(cmd.modelsPath);
	if ("ok" in configResult) {
		return {
			ok: false,
			provider: "local",
			models: [],
			message: configResult.message,
			error: configResult.error,
			category: configResult.category,
			action: configResult.action,
		};
	}

	const diagnostics = await diagnoseLocalModels(configResult, timeoutMs);
	if (diagnostics.check.status === "ok") {
		return {
			ok: true,
			provider: "local",
			baseUrl: configResult.baseUrl,
			models: diagnostics.models,
			message: `Discovered ${diagnostics.models.length} model${diagnostics.models.length === 1 ? "" : "s"}.`,
		};
	}
	return {
		ok: false,
		provider: "local",
		baseUrl: configResult.baseUrl,
		models: [],
		message: "Local provider model discovery failed.",
		error: diagnostics.check.error,
		category: diagnostics.check.category,
		action: diagnostics.check.action,
	};
}

export async function runLocalProviderStatus(cmd: LocalProviderSmokeCommandArgs): Promise<LocalProviderStatusResult> {
	const timeoutMs = cmd.timeoutMs && cmd.timeoutMs > 0 ? cmd.timeoutMs : DEFAULT_TIMEOUT_MS;
	const checks: LocalProviderDiagnosticCheck[] = [];
	const observer = new GatewayQuotaObserver();
	const configResult = await readLocalConfig(cmd.modelsPath);
	// Reported even when there is no local endpoint to diagnose: a provider
	// hidden by an empty key is the likeliest reason the model list is empty,
	// and that provider is usually not the `local` one.
	const hiddenProviders = findProvidersWithEmptyApiKeyEnv(configResult.modelsConfig);
	if ("ok" in configResult) {
		checks.push({
			name: "config",
			status: "error",
			message: configResult.message,
			error: configResult.error,
			category: configResult.category,
			action: configResult.action,
		});
		return {
			ok: false,
			provider: "local",
			models: [],
			checks,
			hiddenProviders,
			message: "Local provider diagnostics failed.",
		};
	}

	checks.push({
		name: "config",
		status: "ok",
		message: "Found providers.local.openaiCompat without mutating config.",
	});
	const modelDiagnostics = await diagnoseLocalModels(configResult, timeoutMs);
	checks.push(modelDiagnostics.check);
	let model = cmd.model?.trim();
	const shouldSmoke = Boolean(cmd.smoke || model);
	if (!shouldSmoke) {
		checks.push({
			name: "chat_stream",
			status: "skipped",
			message: "Streaming chat smoke skipped; pass --smoke or --model to run it.",
		});
	} else if (modelDiagnostics.check.status !== "ok") {
		checks.push({
			name: "chat_stream",
			status: "skipped",
			message: "Streaming chat smoke skipped because GET /v1/models did not pass.",
			action: "Fix the /v1/models diagnostic first, then retry with --smoke or --model.",
		});
	} else {
		model = model || modelDiagnostics.models[0];
		if (!model) {
			checks.push({
				name: "chat_stream",
				status: "skipped",
				message: "Streaming chat smoke skipped because no model id was available.",
				action: "Pass --model with a loaded local model id.",
			});
		} else {
			checks.push(await diagnoseChatStream(configResult, model, timeoutMs, observer));
		}
	}
	const ok = checks.every(check => check.status !== "error");
	// `observer.state` stays null unless the chat request above ran and the
	// endpoint answered as the gateway, so this reports no facts and issues no
	// request of its own when the smoke was skipped.
	const gateway = toGatewayFacts(observer.state, Date.now());
	return {
		ok,
		provider: "local",
		baseUrl: configResult.baseUrl,
		model,
		models: modelDiagnostics.models,
		checks,
		hiddenProviders,
		...(gateway ? { gateway } : {}),
		message: ok ? "Local provider diagnostics passed." : "Local provider diagnostics failed.",
	};
}

export async function runLocalProviderSmoke(cmd: LocalProviderSmokeCommandArgs): Promise<LocalProviderSmokeResult> {
	const timeoutMs = cmd.timeoutMs && cmd.timeoutMs > 0 ? cmd.timeoutMs : DEFAULT_TIMEOUT_MS;
	const configResult = await readLocalConfig(cmd.modelsPath);
	if ("ok" in configResult) {
		// The parsed config rides along for the status command's hidden-provider
		// report; it must never reach this command's `--json` output, which would
		// print every provider block including literal keys.
		const { modelsConfig: _modelsConfig, ...failure } = configResult;
		return failure;
	}

	let model = cmd.model;
	const observer = new GatewayQuotaObserver();
	try {
		model = model?.trim() || (await discoverFirstModel(configResult, timeoutMs));
		const check = await diagnoseChatStream(configResult, model, timeoutMs, observer);
		const gateway = toGatewayFacts(observer.state, Date.now());
		if (check.status === "ok") {
			return {
				ok: true,
				baseUrl: configResult.baseUrl,
				model,
				...(gateway ? { gateway } : {}),
				message: check.message,
			};
		}
		return {
			ok: false,
			baseUrl: configResult.baseUrl,
			model,
			message: check.message,
			error: check.error,
			category: check.category,
			action: check.action,
			...(gateway ? { gateway } : {}),
		};
	} catch (error) {
		const failure = classifyThrownFailure("chat_stream", error, timeoutMs);
		return {
			ok: false,
			baseUrl: configResult.baseUrl,
			model,
			message: failure.message,
			error: failure.error,
			category: failure.category,
			action: failure.action,
		};
	}
}

export async function runLocalProviderDiscoverCommand(
	cmd: Omit<LocalProviderSmokeCommandArgs, "model" | "smoke">,
): Promise<void> {
	const result = await runLocalProviderDiscover(cmd);
	if (cmd.json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else if (result.ok) {
		process.stdout.write(`${chalk.green("ok")} ${result.message}\n`);
		process.stdout.write(`provider=${result.provider} baseUrl=${result.baseUrl}\n`);
		for (const model of result.models) {
			process.stdout.write(`${model}\n`);
		}
	} else {
		process.stderr.write(`${chalk.red("error")} ${result.message}\n`);
		process.stderr.write(`${chalk.dim(`provider=${result.provider} baseUrl=${result.baseUrl ?? "<unknown>"}`)}\n`);
		if (result.error) process.stderr.write(`${chalk.dim(result.error)}\n`);
		if (result.action) process.stderr.write(`${chalk.dim(`action: ${result.action}`)}\n`);
	}
	if (!result.ok) process.exitCode = 1;
}

/**
 * One line per kind of fact the gateway reported. A field the gateway did not
 * send produces no line, so an endpoint that is not behind it prints nothing
 * extra at all.
 */
function gatewayFactLines(facts: LocalProviderGatewayFacts | undefined): string[] {
	if (!facts) return [];
	const lines: string[] = [];
	const budget: string[] = [];
	if (facts.limit !== undefined) budget.push(`limit ${facts.limit}`);
	if (facts.used !== undefined) budget.push(`used ${facts.used}`);
	if (facts.remaining !== undefined) budget.push(`remaining ${facts.remaining}`);
	if (budget.length > 0) lines.push(`gateway tokens: ${budget.join(", ")}`);
	if (facts.resetAt) {
		lines.push(
			facts.resetInMs === undefined
				? `gateway resets: ${facts.resetAt}`
				: `gateway resets: in ${formatApproximateDuration(facts.resetInMs)} (${facts.resetAt})`,
		);
	}
	const queue: string[] = [];
	if (facts.queueDepth !== undefined) queue.push(`depth ${facts.queueDepth}`);
	if (facts.inflight !== undefined) queue.push(`inflight ${facts.inflight}`);
	if (queue.length > 0) lines.push(`gateway queue: ${queue.join(", ")}`);
	if (facts.queuedMs !== undefined) lines.push(`gateway wait: ${facts.queuedMs}ms for an upstream slot`);
	return lines;
}

/** Names the variable, never its value. */
function hiddenProviderLines(hiddenProviders: readonly HiddenProviderApiKeyEnv[]): string[] {
	return hiddenProviders.map(
		entry => `provider "${entry.provider}": ${entry.envName} is not set, its models are hidden`,
	);
}

function renderStatusCheck(check: LocalProviderDiagnosticCheck): string {
	const label =
		check.status === "ok"
			? chalk.green("ok")
			: check.status === "skipped"
				? chalk.yellow("skip")
				: chalk.red("error");
	const suffix = check.category ? chalk.dim(` [${check.category}]`) : "";
	return `${label} ${check.name}: ${check.message}${suffix}\n`;
}

export async function runLocalProviderStatusCommand(cmd: LocalProviderSmokeCommandArgs): Promise<void> {
	const result = await runLocalProviderStatus(cmd);
	if (cmd.json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		const stream = result.ok ? process.stdout : process.stderr;
		stream.write(`${result.ok ? chalk.green("ok") : chalk.red("error")} ${result.message}\n`);
		stream.write(
			`${chalk.dim(`provider=${result.provider} endpoint=${result.baseUrl ?? "<unknown>"}${result.model ? ` model=${result.model}` : ""}`)}\n`,
		);
		for (const check of result.checks) {
			stream.write(renderStatusCheck(check));
			if (check.error) stream.write(`${chalk.dim(`  ${check.error}`)}\n`);
			if (check.action) stream.write(`${chalk.dim(`  action: ${check.action}`)}\n`);
		}
		for (const line of gatewayFactLines(result.gateway)) {
			stream.write(`${chalk.dim(line)}\n`);
		}
		for (const line of hiddenProviderLines(result.hiddenProviders)) {
			stream.write(`${chalk.yellow(line)}\n`);
		}
		if (result.models.length > 0) {
			stream.write(`${chalk.dim(`models: ${result.models.join(", ")}`)}\n`);
		}
	}
	if (!result.ok) process.exitCode = 1;
}

export async function runLocalProviderSmokeCommand(cmd: LocalProviderSmokeCommandArgs): Promise<void> {
	const result = await runLocalProviderSmoke(cmd);
	if (cmd.json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else if (result.ok) {
		process.stdout.write(`${chalk.green("ok")} ${result.message}\n`);
		process.stdout.write(`${chalk.dim(`endpoint=${result.baseUrl} model=${result.model}`)}\n`);
		for (const line of gatewayFactLines(result.gateway)) {
			process.stdout.write(`${chalk.dim(line)}\n`);
		}
	} else {
		process.stderr.write(`${chalk.red("error")} ${result.message}\n`);
		if (result.baseUrl || result.model) {
			process.stderr.write(
				`${chalk.dim(`endpoint=${result.baseUrl ?? "<unknown>"} model=${result.model ?? "<unset>"}`)}\n`,
			);
		}
		if (result.error) process.stderr.write(`${chalk.dim(result.error)}\n`);
		if (result.action) process.stderr.write(`${chalk.dim(`action: ${result.action}`)}\n`);
		for (const line of gatewayFactLines(result.gateway)) {
			process.stderr.write(`${chalk.dim(line)}\n`);
		}
	}
	if (!result.ok) process.exitCode = 1;
}
