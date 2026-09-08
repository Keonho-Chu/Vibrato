import type { FallbackTriggerClass } from "@vib-rato/ai/utils/fallback-transport";
import { truncateToWidth, visibleWidth } from "@vib-rato/tui";
import type { FallbackExhaustionDetails } from "../../session/fallback-exhaustion";
import { suppressionHoldParts } from "../../session/quota-hold-text";
import type { ErrorBlockLine } from "../types";

/**
 * Presentation for an exhausted fallback chain.
 *
 * For a gateway deployment this is the everyday "the allowance is spent" screen,
 * not a rare crash, so it gets a title, a per-model account, and something to
 * do — instead of the single red line the notice message alone produces.
 *
 * Two rules hold the whole file together:
 *
 * 1. Only machine codes are mapped. `triggerClass` and a resolver skip code are
 *    stable identifiers; the raw `reason` text is upstream prose that other
 *    surfaces reformat, so it is never parsed here. An unmapped code is printed
 *    as the code rather than guessed at.
 * 2. Every phrase is quota-window neutral. A gateway counts its limit over an
 *    operator-configured window, so "daily", "today" and "midnight" would all be
 *    wrong; only a reset instant the client was actually given may be shown.
 *
 * The countdown itself is not written here. `quota-hold-text.ts` owns the hold
 * vocabulary shared with the model selector and the session's own error text, so
 * a held model reads identically wherever it is drawn.
 */

/** Widest line this block may produce, so an 80-column terminal never wraps. */
const MAX_LINE_WIDTH = 78;
const DETAIL_INDENT = "  ";

const TRIGGER_PHRASES: Record<FallbackTriggerClass, string> = {
	quota: "token limit reached",
	rate_limit: "rate limited",
	auth: "sign-in rejected",
	server: "server error",
	unknown: "request failed",
	other: "request failed",
};

const SKIP_PHRASES: Record<string, string> = {
	unknown_model: "not a known model",
	unauthenticated: "not signed in",
	provider_disabled: "provider disabled",
	escaped_non_ascii_model_exhausted: "gave up on unreadable arguments",
	snapshot_missing: "no local snapshot",
	credential_unavailable: "no credential available",
};

function triggerPhrase(triggerClass: string): string {
	return TRIGGER_PHRASES[triggerClass as FallbackTriggerClass] ?? triggerClass;
}

function skipPhrase(reason: string): string {
	return SKIP_PHRASES[reason] ?? reason;
}

/**
 * `  <selector> — <phrase>`, narrowed to fit by shortening the SELECTOR.
 *
 * The phrase is the half that says what happened, so it is kept whole and the
 * selector absorbs the loss; a model id is still recognizable from its head,
 * while a truncated "token limit reach…" tells the reader nothing. Width is
 * measured in display columns rather than code units, so a CJK or emoji-bearing
 * model id cannot silently overflow an 80-column terminal.
 *
 * A phrase wide enough to fill the line on its own (only reachable through an
 * unmapped, unusually long code) falls back to trimming the whole line, which
 * keeps the width guarantee absolute.
 */
function detailLine(selector: string, phrase: string): string {
	const suffix = ` — ${phrase}`;
	const available = MAX_LINE_WIDTH - visibleWidth(DETAIL_INDENT) - visibleWidth(suffix);
	if (available <= 0) return truncateToWidth(`${DETAIL_INDENT}${selector}${suffix}`, MAX_LINE_WIDTH);
	return `${DETAIL_INDENT}${truncateToWidth(selector, available)}${suffix}`;
}

/**
 * Lay an exhausted chain out as titled, plain-text lines.
 *
 * `nowMs` is injected so the countdown is testable; callers pass the current
 * time. A reset instant that has already passed produces no countdown line, the
 * same as no instant at all.
 */
export function formatFallbackExhaustionBlock(
	details: FallbackExhaustionDetails,
	nowMs: number = Date.now(),
): ErrorBlockLine[] {
	const lines: ErrorBlockLine[] = [
		{ kind: "title", text: details.quota ? "Token limit reached" : "No model could answer" },
	];

	if (details.tried.length > 0) {
		lines.push({ kind: "heading", text: "Models tried:" });
		for (const failure of details.tried) {
			lines.push({ kind: "detail", text: detailLine(failure.selector, triggerPhrase(failure.triggerClass)) });
		}
	}
	if (details.skipped.length > 0) {
		lines.push({ kind: "heading", text: "Models skipped:" });
		for (const skip of details.skipped) {
			lines.push({ kind: "detail", text: detailLine(skip.selector, skipPhrase(skip.reason)) });
		}
	}
	if (details.resolutionFailure !== undefined) {
		lines.push({ kind: "heading", text: "Could not switch models:" });
		// Free upstream text with no phrase to protect, so the whole line is trimmed.
		lines.push({
			kind: "detail",
			text: truncateToWidth(`${DETAIL_INDENT}${details.resolutionFailure}`, MAX_LINE_WIDTH),
		});
	}

	lines.push({ kind: "blank", text: "" });

	// `suppressionHoldParts` owns the countdown wording and its "already past"
	// rule, so a held model reads the same here as it does beside its row in
	// `/model`. The reason half is deliberately not passed: the condition is
	// already the title of this block, and the recorded reason text belongs to
	// the surfaces that store it.
	const [resetPhrase] = suppressionHoldParts(undefined, details.resetAtMs, nowMs);
	if (resetPhrase) lines.push({ kind: "action", text: resetPhrase });
	lines.push({ kind: "action", text: "/model to pick another model" });
	if (details.quota) lines.push({ kind: "action", text: "ask the gateway admin about your key's limit" });

	return lines;
}
