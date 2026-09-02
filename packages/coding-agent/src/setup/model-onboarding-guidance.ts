import { formatProviderCredentialHint } from "@vib-rato/ai/stream";

export const MODEL_ONBOARDING_API_PROVIDER_COMMAND =
	"/provider add --compat <openai|anthropic> --provider <id> --base-url <url> --api-key-env <ENV> --model <model>";
export const MODEL_ONBOARDING_PROVIDER_PRESET_COMMAND = "/provider add --preset <id>";

export const MODEL_ONBOARDING_SETUP_COMMAND = "vib setup provider";
export const MODEL_ONBOARDING_OAUTH_COMMAND = "/provider login [provider-id] or /login [provider-id]";

/** Primary connection path: any OpenAI-compatible local LLM server. */
export const MODEL_ONBOARDING_LOCAL_ENDPOINT_MENU = '/provider → "Connect a local LLM endpoint"';
export const MODEL_ONBOARDING_LOCAL_ENDPOINT_COMMAND = `${MODEL_ONBOARDING_SETUP_COMMAND} --preset local --base-url http://HOST:PORT/v1`;
export const MODEL_ONBOARDING_CODEX_LOGIN_COMMAND = "/login openai-codex";
export const MODEL_ONBOARDING_CLAUDE_LOGIN_COMMAND = "/login anthropic";

function localEndpointFirstLines(): string[] {
	return [
		`1. Local LLM endpoint (vLLM, SGLang, Ollama, LM Studio, llama.cpp, …): ${MODEL_ONBOARDING_LOCAL_ENDPOINT_MENU}, or ${MODEL_ONBOARDING_LOCAL_ENDPOINT_COMMAND}.`,
		`2. OpenAI Codex login: ${MODEL_ONBOARDING_CODEX_LOGIN_COMMAND}.`,
		`3. Claude login: ${MODEL_ONBOARDING_CLAUDE_LOGIN_COMMAND}.`,
	];
}

export function formatModelOnboardingGuidance(): string {
	return [
		"Model selection only shows configured providers.",
		"Assignment targets are DEFAULT plus the Vibrato role agents: EXECUTOR, ARCHITECT, PLANNER, and CRITIC.",
		"Legacy model-role aliases are compatibility-only and are not shown as assignment targets.",
		...localEndpointFirstLines(),
		`Other provider presets: ${MODEL_ONBOARDING_PROVIDER_PRESET_COMMAND} (or ${MODEL_ONBOARDING_SETUP_COMMAND} --preset <preset>).`,
		`API-compatible custom providers: ${MODEL_ONBOARDING_API_PROVIDER_COMMAND}.`,
		`Other OAuth/subscription providers: ${MODEL_ONBOARDING_OAUTH_COMMAND}.`,
		"Then run /model to select a configured model or assign it to a target.",
	].join("\n");
}

export function formatModelOnboardingInlineHint(): string {
	return `Connect a local LLM endpoint with ${MODEL_ONBOARDING_LOCAL_ENDPOINT_MENU} (or ${MODEL_ONBOARDING_LOCAL_ENDPOINT_COMMAND}); log in with ${MODEL_ONBOARDING_CODEX_LOGIN_COMMAND} or ${MODEL_ONBOARDING_CLAUDE_LOGIN_COMMAND}; add other presets with ${MODEL_ONBOARDING_PROVIDER_PRESET_COMMAND}; custom API providers with ${MODEL_ONBOARDING_API_PROVIDER_COMMAND} (or ${MODEL_ONBOARDING_SETUP_COMMAND}); other OAuth/subscription with ${MODEL_ONBOARDING_OAUTH_COMMAND}; then run /model for DEFAULT, EXECUTOR, ARCHITECT, PLANNER, and CRITIC.`;
}

export function formatNoModelOnboardingError(): string {
	return `No model selected.\n\n${formatModelOnboardingGuidance()}`;
}

export function formatNoCredentialOnboardingError(providerId: string): string {
	const lines = [
		`No credentials found for ${providerId}.`,
		"",
		...localEndpointFirstLines(),
		"",
		`For other presets, configure credentials with ${MODEL_ONBOARDING_PROVIDER_PRESET_COMMAND} (or ${MODEL_ONBOARDING_SETUP_COMMAND} --preset <preset>).`,
		`For custom API-compatible providers, use ${MODEL_ONBOARDING_API_PROVIDER_COMMAND}.`,
		`For OAuth/subscription providers, use ${MODEL_ONBOARDING_OAUTH_COMMAND} (interactive; not available in headless/print mode).`,
	];
	const headlessHint = formatProviderCredentialHint(providerId);
	if (headlessHint) lines.push(headlessHint);
	lines.push(
		"Then run /model to select a configured model or assign it to DEFAULT, EXECUTOR, ARCHITECT, PLANNER, or CRITIC.",
	);
	return lines.join("\n");
}

export function formatNoModelsAvailableFallback(): string {
	return `No models available. ${formatModelOnboardingGuidance()}`;
}
