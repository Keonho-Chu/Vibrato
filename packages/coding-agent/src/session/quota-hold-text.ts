/**
 * User-facing wording for a model selector that is on hold.
 *
 * Two surfaces share this module: the session records why a selector is
 * suppressed and stamps the surfaced error, and the model selector explains a
 * held row in `/model`. They must agree, and they must both read as a countdown
 * rather than as a machine timestamp.
 *
 * Window neutrality is a hard requirement, not a style preference. The gateway
 * counts its token budget against an operator-configured window
 * (`VUG_QUOTA_WINDOW_HOURS`, three hours in production) while its wire contract
 * keeps the historical `daily` header names, so nothing here may say "daily",
 * "today", or name a midnight boundary. The only thing the client knows is the
 * instant the gateway reported, and the only honest way to render it is the
 * distance to it.
 *
 * The distance is deliberately NOT frozen when the hold is recorded. A reason
 * stored as "resets in 2h 30m" would still claim two and a half hours after two
 * hours of work; the stored reason is therefore the bare condition, and every
 * caller composes the countdown from the recorded instant at the moment it
 * draws.
 */

/** Recorded suppression reason for a token-limit hold: the condition, with no time in it. */
export const QUOTA_HOLD_REASON = "token limit reached";

/** A minute-resolution countdown is meaningless below one minute. */
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/**
 * Countdown to an instant that is still ahead, in the status line's vocabulary
 * (`45m`, `2h 30m`, `1d 3h`).
 *
 * Returns `undefined` rather than `0m` for a delta that has run out or rounds
 * away: an expired hold is not "resetting any moment now", it is simply over,
 * and the caller drops the phrase instead of drawing a zero.
 *
 * Deliberately not merged with the two neighbouring countdown formatters, whose
 * rules differ where it matters to their own surfaces: the status line's
 * `formatUsageReset` takes minutes already rounded by the observer and has no
 * day case at all, and the `/usage` panel's own `formatResetCountdown` floors
 * instead of rounding, renders a sub-minute wait as `<1m`, and stays in hours
 * up to 48. Sharing one implementation would silently change what those two
 * draw; this one matches the status line's wording, which is the surface a held
 * model sits beside.
 */
export function formatHoldCountdown(msRemaining: number): string | undefined {
	if (!Number.isFinite(msRemaining) || msRemaining <= 0) return undefined;
	const minutes = Math.round(msRemaining / MS_PER_MINUTE);
	if (minutes < 1) return undefined;
	if (minutes < MINUTES_PER_HOUR) return `${minutes}m`;
	if (minutes < MINUTES_PER_DAY) {
		const hours = Math.floor(minutes / MINUTES_PER_HOUR);
		const remainder = minutes % MINUTES_PER_HOUR;
		return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
	}
	const days = Math.floor(minutes / MINUTES_PER_DAY);
	const hours = Math.floor((minutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
	return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

/** `resets in 2h 30m`, or nothing when the instant is unknown or already past. */
function formatResetPhrase(untilMs: number | undefined, now: number): string | undefined {
	if (untilMs === undefined) return undefined;
	const countdown = formatHoldCountdown(untilMs - now);
	return countdown === undefined ? undefined : `resets in ${countdown}`;
}

/**
 * The hold as an ordered list of phrases — the condition, then the countdown —
 * so each surface can join them with its own separator without duplicating the
 * rules for which halves exist.
 *
 * Either half can be missing: a rate-limit suppression has always been
 * reasonless, and an instant that has passed contributes no countdown.
 */
export function suppressionHoldParts(
	reason: string | undefined,
	untilMs: number | undefined,
	now = Date.now(),
): string[] {
	const parts: string[] = [];
	const trimmedReason = reason?.trim();
	if (trimmedReason) parts.push(trimmedReason);
	const reset = formatResetPhrase(untilMs, now);
	if (reset) parts.push(reset);
	return parts;
}
