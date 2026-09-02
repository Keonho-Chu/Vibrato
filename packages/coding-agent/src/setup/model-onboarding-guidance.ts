import { formatProviderCredentialHint } from "@vib-rato/ai/stream";

export const MODEL_ONBOARDING_API_PROVIDER_COMMAND =
	"/provider add --compat <openai|anthropic> --provider <id> --base-url <url> --api-key-env <ENV> --model <model>";
export const MODEL_ONBOARDING_PROVIDER_PRESET_COMMAND = "/provider add --preset <id>";

export const MODEL_ONBOARDING_SETUP_COMMAND = "vib setup provider";

/** Primary connection path: any OpenAI-compatible local LLM server. */
export const MODEL_ONBOARDING_LOCAL_ENDPOINT_COMMAND = `${MODEL_ONBOARDING_SETUP_COMMAND} --preset local --base-url http://HOST:PORT/v1`;
export const MODEL_ONBOARDING_CODEX_LOGIN_COMMAND = "/login openai-codex";
export const MODEL_ONBOARDING_CLAUDE_LOGIN_COMMAND = "/login anthropic";

/**
 * These "no model yet" surfaces are the only Korean strings in the product: they are read
 * by operators at a Korean site before anything is connected. Everything else stays English,
 * and command names, flags, provider ids, and URLs are never translated.
 *
 * Routes that do not belong on a first-run screen live where they are actually used:
 * assignment targets in the `/model` usage lines, and provider presets, custom
 * API-compatible providers, and OAuth logins in the `/provider` usage text.
 */
const ROUTE_LABEL_WIDTH = 21;

function routeLine(command: string, description: string): string {
	return `  ${command.padEnd(ROUTE_LABEL_WIDTH)}${description}`;
}

const LOCAL_ENDPOINT_ROUTE = routeLine("/provider", "로컬 LLM 엔드포인트 연결 (권장)");
const CODEX_ROUTE = routeLine(MODEL_ONBOARDING_CODEX_LOGIN_COMMAND, "OpenAI Codex 로그인");
const CLAUDE_ROUTE = routeLine(MODEL_ONBOARDING_CLAUDE_LOGIN_COMMAND, "Claude 로그인");
const SELECT_MODEL_LINE = "연결한 뒤 /model 로 모델을 고르십시오.";

export function formatModelOnboardingGuidance(): string {
	return [LOCAL_ENDPOINT_ROUTE, CODEX_ROUTE, CLAUDE_ROUTE, "", SELECT_MODEL_LINE].join("\n");
}

export function formatModelOnboardingInlineHint(): string {
	return `/provider 로 로컬 LLM 엔드포인트를 연결하거나 ${MODEL_ONBOARDING_CODEX_LOGIN_COMMAND} 또는 ${MODEL_ONBOARDING_CLAUDE_LOGIN_COMMAND} 으로 로그인하십시오.`;
}

export function formatNoModelOnboardingError(): string {
	return `설정된 모델이 없습니다.\n\n${formatModelOnboardingGuidance()}`;
}

export function formatNoCredentialOnboardingError(providerId: string): string {
	// The two login routes below already cover Codex and Claude; only another provider
	// needs its own line, and that line is honest that /login serves OAuth providers.
	const providerLogin =
		providerId === "openai-codex" || providerId === "anthropic"
			? []
			: [
					routeLine(
						`/login ${providerId}`,
						`${providerId} 로그인 (OAuth·구독 공급자 한정, 대화형 전용이라 headless/print 모드에서는 쓸 수 없습니다)`,
					),
				];
	const lines = [
		`${providerId} 자격 증명을 찾을 수 없습니다.`,
		"",
		LOCAL_ENDPOINT_ROUTE,
		...providerLogin,
		CODEX_ROUTE,
		CLAUDE_ROUTE,
		"",
	];
	const headlessHint = formatProviderCredentialHint(providerId);
	if (headlessHint) lines.push(headlessHint, "");
	lines.push(SELECT_MODEL_LINE);
	return lines.join("\n");
}

/**
 * Non-interactive variant: slash commands do not exist in headless/print launches, so this
 * one names the shell command instead.
 */
export function formatNoModelsAvailableFallback(): string {
	return [
		"사용 가능한 모델이 없습니다.",
		"",
		`  로컬 LLM 엔드포인트: ${MODEL_ONBOARDING_LOCAL_ENDPOINT_COMMAND}`,
		`  Codex·Claude 로그인: vib 를 대화형으로 실행한 뒤 ${MODEL_ONBOARDING_CODEX_LOGIN_COMMAND} 또는 ${MODEL_ONBOARDING_CLAUDE_LOGIN_COMMAND}`,
		"",
		"연결한 뒤 다시 실행하십시오.",
	].join("\n");
}
