import type { FallbackTriggerClass } from "@vib-rato/ai/utils/fallback-transport";

/**
 * Machine-readable description of an exhausted fallback chain.
 *
 * The one-line `Model fallback chain exhausted; …` string is a stable contract
 * that the SDK, ACP, print mode and the retry admission check all depend on, so
 * it is never restructured. This type carries the SAME facts in a form a
 * renderer can lay out, and {@link formatFallbackExhaustionMessage} is the only
 * producer of the string — the two therefore cannot drift apart.
 *
 * `triggerClass` is the machine reason code (`quota`, `auth`, `server`, …);
 * `reason` is the raw upstream text that goes into the string. A presentation
 * surface should map the code, never parse the text.
 */
export interface FallbackExhaustionAttempt {
	selector: string;
	triggerClass: FallbackTriggerClass;
	reason: string;
}

/** A chain entry that was never attempted, with the resolver's reason code. */
export interface FallbackExhaustionSkip {
	selector: string;
	reason: string;
}

export interface FallbackExhaustionDetails {
	tried: readonly FallbackExhaustionAttempt[];
	skipped: readonly FallbackExhaustionSkip[];
	/** Every attempted model failed for a spent token allowance. */
	quota: boolean;
	/**
	 * Earliest instant at which an attempted selector leaves its suppression
	 * window, when one is recorded. Absent when nothing is held: a surface must
	 * then omit any reset wording rather than inventing a window.
	 */
	resetAtMs?: number;
	/** Present only on the resolution path, where advancing itself threw. */
	resolutionFailure?: string;
}

/**
 * Prefix of the exhaustion string. `AgentSession` admission checks compare
 * against this exact text, and out-of-process consumers match on it.
 */
export const FALLBACK_EXHAUSTION_MESSAGE_PREFIX = "Model fallback chain exhausted;";

/** Build the stable single-line exhaustion message from the structured facts. */
export function formatFallbackExhaustionMessage(details: FallbackExhaustionDetails): string {
	const tried = details.tried.map(failure => `${failure.selector} (${failure.reason})`).join(", ") || "none";
	const skipped = details.skipped.map(skip => `${skip.selector} (${skip.reason})`).join(", ") || "none";
	const base = `${FALLBACK_EXHAUSTION_MESSAGE_PREFIX} models tried: ${tried}; models skipped: ${skipped}`;
	return details.resolutionFailure === undefined ? base : `${base}; resolution failed: ${details.resolutionFailure}`;
}

/**
 * Fold another known reset instant into the details, keeping the earliest.
 *
 * The exhaustion message can be annotated with a `retryable at …` or a
 * token-hold instant that no selector suppression recorded — a credential-pool
 * hold, for one. A renderer that only ever saw the suppression window would then
 * show LESS than the one-line message it stands in for, which is the one thing
 * this structure must never do, so every site that stamps such an instant onto
 * the string folds the same value in here.
 *
 * Earliest wins, for the same reason the suppression scan takes the earliest: it
 * is the moment work can resume.
 */
export function withEarliestReset(
	details: FallbackExhaustionDetails,
	candidateMs: number | undefined,
): FallbackExhaustionDetails {
	if (candidateMs === undefined || !Number.isFinite(candidateMs)) return details;
	if (details.resetAtMs !== undefined && details.resetAtMs <= candidateMs) return details;
	return { ...details, resetAtMs: candidateMs };
}

/**
 * True when the chain ran out because every attempted model had spent its
 * allowance. A chain where nothing was attempted is not a token-limit case: it
 * failed to resolve, which is a different thing to tell the user.
 */
export function fallbackExhaustionIsQuota(tried: readonly FallbackExhaustionAttempt[]): boolean {
	return tried.length > 0 && tried.every(failure => failure.triggerClass === "quota");
}
