/**
 * User-facing explanation for a failed `/v1/models` discovery fetch.
 *
 * Extracted from the model selector so the wording is unit-testable without
 * constructing a TUI component. The registry keeps its own behavior: a failed
 * fetch never deletes approved static `models:` entries and never invalidates a
 * still-valid discovery cache, so the only thing at stake here is what the user
 * is told about a provider that is temporarily refusing to list its models.
 */

/** Discovery errors are raised in this exact shape by the OpenAI-style fetcher. */
const HTTP_DISCOVERY_ERROR = /^HTTP (\d+) from (.+)$/;

/**
 * Returns an indented hint line, or `undefined` when the error is not a
 * recognized HTTP discovery failure and the caller should fall back to its
 * generic wording.
 */
export function formatDiscoveryErrorHint(error: string | undefined): string | undefined {
	if (!error) return undefined;
	const httpMatch = HTTP_DISCOVERY_ERROR.exec(error);
	if (!httpMatch) return undefined;
	const [, statusCode, url] = httpMatch;
	if (statusCode === "404") {
		return `  Discovery endpoint ${url} returned 404. Point baseUrl at the host that serves /models (usually .../v1).`;
	}
	// A gateway that has spent its daily allowance answers /v1/models with 429
	// exactly as it answers a completion (issue #8 §4). Reported as a bare
	// "Discovery failed", that reads like a bad key or a deleted model and sends
	// the user to re-authenticate. Name the limit instead, and say plainly that
	// the models already configured are still there.
	if (statusCode === "429") {
		return `  Usage limit reached at ${url}, so the live model list could not be refreshed. Configured and cached models stay available; the list refreshes once the limit resets.`;
	}
	return `  Discovery failed: ${error}`;
}
