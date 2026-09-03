import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDbPath, getAgentDir } from "@vib-rato/utils";
import { YAML } from "bun";
import { type ModelsConfig, ModelsConfigSchema, type ProviderDiscovery } from "../config/models-config-schema";
import { isSelectableProvider } from "../config/provider-allowlist";
import { compareRankedProviders, famousProviderIndex } from "../config/provider-ranking";
import { AuthStorage } from "../session/auth-storage";
import providerPresets from "./provider-presets.json";

export type ProviderCompatibility = "openai" | "anthropic";
export type ProviderSetupApi = "openai-responses" | "openai-completions" | "anthropic-messages";

export interface ProviderSetupInput {
	compatibility?: ProviderCompatibility;
	preset?: string;
	providerId?: string;
	baseUrl?: string;
	apiKey?: string;
	apiKeyEnv?: string;
	models?: string[];
	modelsPath?: string;
	force?: boolean;
}

export interface ProviderSetupResult {
	providerId: string;
	compatibility: ProviderCompatibility;
	api: ProviderSetupApi;
	baseUrl: string;
	modelIds: string[];
	modelsPath: string;
	redactedApiKey: string;
	credentialSource: "literal" | "env";
	/** The endpoint is reachable without the key; it is sent only if present. */
	apiKeyOptional?: boolean;
	preset?: string;
	presetName?: string;
}

type ProviderConfig = NonNullable<NonNullable<ModelsConfig["providers"]>[string]>;
type ProviderCompatConfig = NonNullable<ProviderConfig["compat"]>;

interface ProviderPreset {
	id: string;
	aliases: readonly string[];
	name: string;
	description: string;
	compatibility: ProviderCompatibility;
	api: ProviderSetupApi;
	providerId: string;
	baseUrl?: string;
	apiKeyEnv: string;
	models?: readonly string[];
	modelApi?: Readonly<Record<string, ProviderSetupApi>>;
	compat?: ProviderCompatConfig;
	discovery?: ProviderDiscovery;
	/**
	 * Parameterized presets (proxy gateways) do not hardcode a base URL or an
	 * unoverridable apiKeyEnv: the caller must supply `--base-url` and may
	 * override `--api-key-env`. `baseUrl` is absent for these presets.
	 */
	parameterized?: boolean;
	/**
	 * The endpoint usually needs no credential at all — a local LLM server such
	 * as Ollama, LM Studio, or llama.cpp. See `writesOptionalAuthProvider` for
	 * what this changes in the generated `models.yml` entry.
	 */
	optionalApiKey?: boolean;
}

/**
 * Whether the generated entry should treat its API key as optional.
 *
 * A local endpoint is usually unauthenticated, so an explicit
 * `auth: apiKey` + `apiKeyEnv` entry is the wrong shape: with the variable
 * unset the registry reports the provider unauthenticated and discovers
 * nothing, which is exactly the state a user lands in after
 * `setup provider --preset local --base-url ...` with no key to give. The
 * registry's `openaiCompat` form makes the credential optional instead —
 * discovery runs unauthenticated, and the key is sent as soon as the user
 * exports the variable. A pasted key means the user does have one, so that
 * path keeps the explicit shape.
 */
function writesOptionalAuthProvider(
	preset: ProviderPreset | undefined,
	credentialSource: ProviderSetupResult["credentialSource"],
): boolean {
	return preset?.optionalApiKey === true && credentialSource === "env";
}

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const REDACT_PREFIX = 4;
const REDACT_SUFFIX = 4;
export const PROVIDER_PRESETS: readonly ProviderPreset[] = (providerPresets as ProviderPreset[]).filter(preset =>
	isSelectableProvider(preset.providerId),
);

export function getDefaultModelsPath(): string {
	return path.join(getAgentDir(), "models.yml");
}

export function normalizeProviderId(providerId: string): string {
	return providerId.trim().toLowerCase();
}

export function parseProviderCompatibility(value: string): ProviderCompatibility {
	const normalized = value.trim().toLowerCase();
	if (normalized === "openai" || normalized === "openai-compatible" || normalized === "oai") return "openai";
	if (normalized === "anthropic" || normalized === "anthropic-compatible" || normalized === "claude") {
		return "anthropic";
	}
	throw new Error("Provider compatibility must be 'openai' or 'anthropic'.");
}

export function findProviderPreset(value: string | undefined): ProviderPreset | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return undefined;
	return PROVIDER_PRESETS.find(preset => preset.id === normalized || preset.aliases.includes(normalized));
}

function providerPresetRankingId(preset: ProviderPreset): string {
	return (
		[preset.providerId, preset.id, ...preset.aliases].find(id => famousProviderIndex(id) !== undefined) ?? preset.id
	);
}

export function formatProviderPresetList(): string {
	return [...PROVIDER_PRESETS]
		.sort((left, right) =>
			compareRankedProviders(
				{ id: providerPresetRankingId(left), label: left.name, authState: "none" },
				{ id: providerPresetRankingId(right), label: right.name, authState: "none" },
			),
		)
		.map(preset => {
			const aliases = preset.aliases.length > 0 ? ` (aliases: ${preset.aliases.join(", ")})` : "";
			return `${preset.id}${aliases}: ${preset.description}`;
		})
		.join("\n");
}

export function parseModelList(values: readonly string[]): string[] {
	const models = values
		.flatMap(value => value.split(","))
		.map(value => value.trim())
		.filter(value => value.length > 0);
	return [...new Set(models)];
}

export function redactSecret(secret: string): string {
	const trimmed = secret.trim();
	if (trimmed.length <= REDACT_PREFIX + REDACT_SUFFIX) return "***";
	return `${trimmed.slice(0, REDACT_PREFIX)}…${trimmed.slice(-REDACT_SUFFIX)}`;
}

function apiForCompatibility(compatibility: ProviderCompatibility): ProviderSetupApi {
	return compatibility === "openai" ? "openai-responses" : "anthropic-messages";
}

function resolvePresetInput(input: ProviderSetupInput): {
	compatibility: ProviderCompatibility;
	preset?: ProviderPreset;
	providerId?: string;
	baseUrl?: string;
	apiKey?: string;
	apiKeyEnv?: string;
	models: readonly string[];
	modelApi?: Readonly<Record<string, ProviderSetupApi>>;
	api: ProviderSetupApi;
	compat?: ProviderCompatConfig;
	discovery?: ProviderDiscovery;
} {
	const preset = input.preset ? findProviderPreset(input.preset) : undefined;
	if (input.preset && !preset) {
		throw new Error(`Unknown provider preset '${input.preset}'. Available presets:\n${formatProviderPresetList()}`);
	}
	if (preset && input.compatibility && input.compatibility !== preset.compatibility) {
		throw new Error(
			`Provider preset '${preset.id}' is ${preset.compatibility}-compatible; omit --compat or use '${preset.compatibility}'.`,
		);
	}
	if (preset && input.baseUrl !== undefined && !preset.parameterized) {
		throw new Error(
			`Provider preset '${preset.id}' uses a fixed base URL; omit --base-url or use --compat openai for a custom provider.`,
		);
	}
	if (preset?.parameterized && !input.baseUrl) {
		throw new Error(
			`Provider preset '${preset.id}' requires --base-url <url> (your proxy endpoint). Use --compat openai for a fully custom provider instead.`,
		);
	}
	if (preset && input.models && input.models.length > 0) {
		const catalogMode =
			preset.models && preset.models.length > 0 ? "uses fixed model ids" : "discovers models automatically";
		throw new Error(
			`Provider preset '${preset.id}' ${catalogMode}; omit --model or use --compat openai for a custom provider.`,
		);
	}
	if (
		preset &&
		input.apiKeyEnv !== undefined &&
		!preset.parameterized &&
		input.apiKeyEnv.trim() !== preset.apiKeyEnv
	) {
		throw new Error(
			`Provider preset '${preset.id}' uses ${preset.apiKeyEnv}; omit --api-key-env or use --compat openai for a custom provider.`,
		);
	}
	const compatibility = preset?.compatibility ?? input.compatibility;
	if (!compatibility) {
		throw new Error("Provider compatibility is required unless --preset is used.");
	}
	return {
		compatibility,
		preset,
		providerId: input.providerId ?? preset?.providerId,
		baseUrl: input.baseUrl ?? preset?.baseUrl,
		apiKey: input.apiKey,
		apiKeyEnv: input.apiKeyEnv ?? preset?.apiKeyEnv,
		models: input.models && input.models.length > 0 ? input.models : (preset?.models ?? []),
		modelApi: preset?.modelApi,
		api: preset?.api ?? apiForCompatibility(compatibility),
		compat: preset?.compat,
		discovery: preset?.discovery,
	};
}

export function validateModelApi(
	modelApi: Readonly<Record<string, string>> | undefined,
	models: readonly string[],
	presetId: string,
): void {
	if (!modelApi) return;
	const modelSet = new Set(models);
	const validApis: readonly string[] = ["openai-responses", "openai-completions", "anthropic-messages"];
	for (const [key, value] of Object.entries(modelApi)) {
		if (!modelSet.has(key)) {
			throw new Error(`Provider preset '${presetId}' declares modelApi for unknown model '${key}'.`);
		}
		if (!validApis.includes(value)) {
			throw new Error(
				`Provider preset '${presetId}' declares invalid modelApi value '${value}' for model '${key}'.`,
			);
		}
	}
}

function validateSetupInput(input: ProviderSetupInput): {
	providerId: string;
	baseUrl: string;
	apiKey: string;
	credentialSource: ProviderSetupResult["credentialSource"];
	models: string[];
	compatibility: ProviderCompatibility;
	api: ProviderSetupApi;
	compat?: ProviderCompatConfig;
	modelApi?: Readonly<Record<string, ProviderSetupApi>>;
	discovery?: ProviderDiscovery;
	preset?: ProviderPreset;
} {
	const resolved = resolvePresetInput(input);
	if (!resolved.providerId) throw new Error("Provider id is required.");
	if (!resolved.baseUrl) throw new Error("Base URL is required.");
	const providerId = normalizeProviderId(resolved.providerId);
	if (!PROVIDER_ID_PATTERN.test(providerId)) {
		throw new Error("Provider id must use lowercase letters, numbers, dots, underscores, or hyphens.");
	}

	const baseUrl = resolved.baseUrl.trim();
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error("Base URL must be a valid absolute URL.");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Base URL must use http or https.");
	}

	const apiKeyEnv = resolved.apiKeyEnv?.trim();
	if (apiKeyEnv) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
			throw new Error("API key environment variable must be a valid environment variable name.");
		}
	}
	// A pasted key wins over a preset's default env-var name; an explicit env name still applies when no literal key is given.
	const literalApiKey = resolved.apiKey?.trim() || undefined;
	const apiKey = literalApiKey ?? apiKeyEnv ?? "";
	if (!apiKey) throw new Error("API key is required.");

	const models = parseModelList(resolved.models);
	// vLLM and SGLang speak the chat-completions API; a bare provider id should
	// not inherit the generic OpenAI default (responses API).
	const api =
		!resolved.preset && (providerId === "vllm" || providerId === "sglang") ? "openai-completions" : resolved.api;
	// vLLM and SGLang expose /v1/models, so a bare endpoint needs no model list.
	const discovery =
		resolved.discovery ??
		(models.length === 0 && (providerId === "vllm" || providerId === "sglang") ? { type: providerId } : undefined);
	if (models.length === 0 && !discovery) throw new Error("At least one model id or model discovery is required.");
	validateModelApi(resolved.modelApi, models, resolved.preset?.id ?? resolved.providerId);

	return {
		providerId,
		baseUrl,
		apiKey,
		credentialSource: literalApiKey ? "literal" : "env",
		models,
		compatibility: resolved.compatibility,
		api,
		modelApi: resolved.modelApi,
		compat: resolved.compat,
		discovery,
		preset: resolved.preset,
	};
}

async function readModelsConfig(modelsPath: string): Promise<ModelsConfig> {
	const file = Bun.file(modelsPath);
	if (!(await file.exists())) return {};
	const text = (await file.text()).trim();
	if (!text) return {};
	const parsed = modelsPath.endsWith(".json") || modelsPath.endsWith(".jsonc") ? JSON.parse(text) : YAML.parse(text);
	const checked = ModelsConfigSchema.safeParse(parsed);
	if (!checked.success) {
		const first = checked.error.issues[0];
		const where = first?.path.length ? `/${first.path.map(String).join("/")}` : "root";
		throw new Error(`Existing models config is invalid at ${where}: ${first?.message ?? "unknown schema error"}`);
	}
	return checked.data;
}

async function writeModelsConfig(modelsPath: string, config: ModelsConfig): Promise<void> {
	const checked = ModelsConfigSchema.safeParse(config);
	if (!checked.success) {
		const first = checked.error.issues[0];
		const where = first?.path.length ? `/${first.path.map(String).join("/")}` : "root";
		throw new Error(`Generated models config is invalid at ${where}: ${first?.message ?? "unknown schema error"}`);
	}
	const directory = path.dirname(modelsPath);
	await fs.mkdir(directory, { recursive: true });
	const tempPath = path.join(directory, `.${path.basename(modelsPath)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		const tempHandle = await fs.open(tempPath, "wx", 0o600);
		try {
			await tempHandle.writeFile(YAML.stringify(checked.data, null, 2), "utf8");
			await tempHandle.sync();
		} finally {
			await tempHandle.close();
		}
		await fs.rename(tempPath, modelsPath);
		try {
			const directoryHandle = await fs.open(directory, "r");
			try {
				await directoryHandle.sync();
			} finally {
				await directoryHandle.close();
			}
		} catch {
			// Directory fsync is unavailable on some filesystems; the replacement succeeded.
		}
	} finally {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
	}
}

export async function addApiCompatibleProvider(input: ProviderSetupInput): Promise<ProviderSetupResult> {
	const validated = validateSetupInput(input);
	const modelsPath = input.modelsPath ?? getDefaultModelsPath();
	const existing = await readModelsConfig(modelsPath);
	if (existing.providers?.[validated.providerId] && !input.force) {
		throw new Error(`Provider '${validated.providerId}' already exists. Use --force to replace it.`);
	}
	const optionalAuth = writesOptionalAuthProvider(validated.preset, validated.credentialSource);
	// `openaiCompat` already implies openai-completions and an
	// `openai-models-list` discovery against its own base URL, so the explicit
	// api/auth/discovery fields would only restate it.
	const provider: ProviderConfig = optionalAuth
		? { openaiCompat: { baseUrl: validated.baseUrl, apiKeyEnv: validated.apiKey } }
		: {
				baseUrl: validated.baseUrl,
				api: validated.api,
				auth: "apiKey",
				...(validated.models.length > 0
					? {
							models: validated.models.map(id => {
								const api = validated.modelApi?.[id];
								return api ? { id, api } : { id };
							}),
						}
					: {}),
			};
	if (!optionalAuth) {
		if (validated.compat) provider.compat = validated.compat;
		if (validated.discovery) provider.discovery = validated.discovery;
	}
	if (validated.credentialSource === "env") {
		if (!optionalAuth) provider.apiKeyEnv = validated.apiKey;
	} else {
		const authStorage = await AuthStorage.create(getAgentDbPath());
		try {
			await authStorage.set(validated.providerId, { type: "api_key", key: validated.apiKey });
		} finally {
			authStorage.close();
		}
	}
	const next: ModelsConfig = {
		...existing,
		providers: {
			...(existing.providers ?? {}),
			[validated.providerId]: provider,
		},
	};
	await writeModelsConfig(modelsPath, next);
	return {
		providerId: validated.providerId,
		compatibility: validated.compatibility,
		api: validated.api,
		baseUrl: validated.baseUrl,
		modelIds: validated.models,
		modelsPath,
		redactedApiKey: redactSecret(validated.apiKey),
		credentialSource: validated.credentialSource,
		...(optionalAuth ? { apiKeyOptional: true } : {}),
		preset: validated.preset?.id,
		presetName: validated.preset?.name,
	};
}

/**
 * Whether plain `http:` is acceptable for this hostname.
 *
 * Exported so the one-screen local-endpoint connect flow
 * (`./local-endpoint`) applies the same rule the CLI/wizard path applies,
 * instead of carrying a second copy that can drift.
 */
export function isLocalHttpHost(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[(.*)]$/, "$1");
	if (
		normalized === "localhost" ||
		normalized === "127.0.0.1" ||
		normalized === "::1" ||
		normalized.endsWith(".localhost") ||
		/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
	) {
		return true;
	}
	// Private-network hosts (a vLLM/SGLang box on the LAN) are served over plain
	// http far more often than not; keep https mandatory for public hosts.
	if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
	if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
	if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
	if (/^f[cd][0-9a-f]{2}:/.test(normalized) || /^fe[89ab][0-9a-f]:/.test(normalized)) return true;
	if (normalized.endsWith(".local") || normalized.endsWith(".internal") || normalized.endsWith(".lan")) return true;
	// A bare single-label hostname only resolves inside the local network.
	return /^[a-z0-9-]+$/.test(normalized) && !/^\d+$/.test(normalized);
}

export function formatProviderSetupResult(result: ProviderSetupResult): string {
	return [
		`Provider '${result.providerId}' configured as ${result.compatibility}-compatible.`,
		...(result.presetName ? [`Preset: ${result.presetName}`] : []),
		`Models: ${result.modelIds.length > 0 ? result.modelIds.join(", ") : "discovered automatically"}`,
		`Base URL: ${result.baseUrl}`,
		`API key: ${
			result.credentialSource === "env"
				? `${result.redactedApiKey} (environment variable${result.apiKeyOptional ? ", optional — the endpoint is used unauthenticated until it is set" : ""})`
				: result.redactedApiKey
		}`,
		`Config: ${result.modelsPath}`,
	].join("\n");
}
