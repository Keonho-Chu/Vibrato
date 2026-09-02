/**
 * Product-level provider allowlist.
 *
 * Vibrato exposes one generic local endpoint plus a small set of named
 * providers for selection: a generic local LLM endpoint (`local`, any
 * OpenAI-compatible server), the named self-hosted endpoints vLLM and SGLang,
 * OpenAI Codex (browser and device-code login), and Anthropic (Claude).
 * Every other built-in provider stays compiled in (transports, tests, and
 * explicit `models.yml` overrides keep working) but is hidden from every
 * selection surface: `/login`, `/model`, provider ordering, presets, and the
 * CLI setup help. User-authored custom providers in `models.yml` that do not
 * collide with a built-in id remain selectable because they are the user's
 * own vLLM/SGLang-style endpoints.
 *
 * This complements the `disabledProviders` setting (a user deny-list); it is
 * not configurable at runtime.
 */
import { KNOWN_PROVIDERS, type OAuthProviderInfo } from "@vib-rato/ai/core";
import { getOAuthProviders } from "@vib-rato/ai/utils/oauth";

/** Provider ids a user may pick anywhere in the product. */
export const SELECTABLE_PROVIDER_IDS: readonly string[] = Object.freeze([
	"local",
	"vllm",
	"sglang",
	"openai-codex",
	"openai-codex-device",
	"anthropic",
]);

/**
 * OAuth registry entries that store web-search credentials rather than model
 * access. They are not model providers, so the allowlist does not apply.
 */
export const NON_MODEL_OAUTH_PROVIDER_IDS: readonly string[] = Object.freeze([
	"tavily",
	"kagi",
	"parallel",
	"perplexity",
]);

const SELECTABLE = new Set<string>(SELECTABLE_PROVIDER_IDS);
const NON_MODEL_OAUTH = new Set<string>(NON_MODEL_OAUTH_PROVIDER_IDS);
const BUILT_IN = new Set<string>(KNOWN_PROVIDERS);

export function isSelectableProvider(providerId: string): boolean {
	return SELECTABLE.has(providerId);
}

/**
 * Whether a provider may appear in a selection surface. Allowlisted providers
 * always may; ids that are not built-in providers are user-authored custom
 * endpoints (their own vLLM/SGLang-style servers) and may too; every other
 * built-in provider is hidden.
 */
export function isProviderSelectable(providerId: string): boolean {
	const id = providerId.trim().toLowerCase();
	return SELECTABLE.has(id) || !BUILT_IN.has(id);
}

/** Keep only models whose provider is selectable. */
export function selectableModels<T extends { provider: string }>(models: readonly T[]): T[] {
	return models.filter(model => isProviderSelectable(model.provider));
}

/**
 * Built-in provider ids that must be hidden from selection. `extraBuiltIns`
 * lets callers fold in ids they know about (bundled catalog keys, discovery
 * descriptors) so the hidden set covers every built-in surface.
 */
export function hiddenBuiltInProviderIds(extraBuiltIns: Iterable<string> = []): Set<string> {
	const hidden = new Set<string>();
	for (const id of BUILT_IN) if (!SELECTABLE.has(id)) hidden.add(id);
	for (const id of extraBuiltIns) if (!SELECTABLE.has(id)) hidden.add(id);
	return hidden;
}

/** OAuth providers the product offers in `/login` and related pickers. */
export function getSelectableOAuthProviders(): OAuthProviderInfo[] {
	return getOAuthProviders().filter(provider => SELECTABLE.has(provider.id) || NON_MODEL_OAUTH.has(provider.id));
}
