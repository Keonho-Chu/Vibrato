/**
 * The limit-reached screen.
 *
 * When a fallback chain runs out, the interactive TUI used to print one red
 * line: `fallback: Model fallback chain exhausted; models tried: …`. On a
 * gateway deployment that line is the everyday "the allowance is spent" screen,
 * so it is now laid out with a title, a per-model account, and a next action.
 *
 * Two things are asserted here:
 *
 * 1. `formatFallbackExhaustionBlock` maps only machine codes and stays
 *    quota-window neutral. The raw upstream `reason` text is never shown for an
 *    attempted model, because that text is prose other surfaces reformat.
 * 2. `EventController` renders the block only when the notice carries the
 *    structure, and otherwise still prints the single prefixed line.
 */
import { describe, expect, it, vi } from "bun:test";
import { EventController } from "@vib-rato/coding-agent/modes/controllers/event-controller";
import type { ErrorBlockLine, InteractiveModeContext } from "@vib-rato/coding-agent/modes/types";
import { formatFallbackExhaustionBlock } from "@vib-rato/coding-agent/modes/utils/fallback-exhaustion-block";
import { UiHelpers } from "@vib-rato/coding-agent/modes/utils/ui-helpers";
import type { AgentSessionEvent } from "@vib-rato/coding-agent/session/agent-session";
import type { FallbackExhaustionDetails } from "@vib-rato/coding-agent/session/fallback-exhaustion";
import { visibleWidth } from "@vib-rato/tui";

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);

function texts(lines: readonly ErrorBlockLine[]): string[] {
	return lines.map(line => line.text);
}

function quotaDetails(overrides: Partial<FallbackExhaustionDetails> = {}): FallbackExhaustionDetails {
	return {
		tried: [
			{ selector: "local/VIB", triggerClass: "quota", reason: "Token allowance exhausted for this key" },
			{ selector: "local/VIB-mini", triggerClass: "quota", reason: "Token allowance exhausted for this key" },
		],
		skipped: [{ selector: "openai/gpt-4o-mini", reason: "unauthenticated" }],
		quota: true,
		resetAtMs: NOW + 2 * 3_600_000 + 30 * 60_000,
		...overrides,
	};
}

function resetLine(details: FallbackExhaustionDetails, now: number): string | undefined {
	return texts(formatFallbackExhaustionBlock(details, now)).find(line => line.startsWith("resets in"));
}

/**
 * The countdown itself belongs to `quota-hold-text.ts`, which the model selector
 * and the session's error text share; its own rounding rules are tested there.
 * What is asserted here is only that this block spends that shared vocabulary
 * rather than inventing a second one.
 */
describe("formatFallbackExhaustionBlock — the shared hold countdown", () => {
	it("renders hours and minutes, minutes alone, and a whole hour", () => {
		expect(resetLine(quotaDetails({ resetAtMs: NOW + 2 * 3_600_000 + 30 * 60_000 }), NOW)).toBe("resets in 2h 30m");
		expect(resetLine(quotaDetails({ resetAtMs: NOW + 45 * 60_000 }), NOW)).toBe("resets in 45m");
		expect(resetLine(quotaDetails({ resetAtMs: NOW + 3 * 3_600_000 }), NOW)).toBe("resets in 3h");
	});

	it("draws no countdown for an instant that has run out", () => {
		expect(resetLine(quotaDetails({ resetAtMs: NOW }), NOW)).toBeUndefined();
		expect(resetLine(quotaDetails({ resetAtMs: NOW - 60_000 }), NOW)).toBeUndefined();
	});
});

describe("formatFallbackExhaustionBlock — quota case", () => {
	it("titles the token limit, names every model in plain words, and offers the next actions", () => {
		const lines = formatFallbackExhaustionBlock(quotaDetails(), NOW);

		expect(texts(lines)).toEqual([
			"Token limit reached",
			"Models tried:",
			"  local/VIB — token limit reached",
			"  local/VIB-mini — token limit reached",
			"Models skipped:",
			"  openai/gpt-4o-mini — not signed in",
			"",
			"resets in 2h 30m",
			"/model to pick another model",
			"ask the gateway admin about your key's limit",
		]);
		expect(lines[0]).toMatchObject({ kind: "title" });
	});

	it("never says daily, today, or midnight, and never repeats the raw upstream text", () => {
		const rendered = texts(formatFallbackExhaustionBlock(quotaDetails(), NOW)).join("\n");

		expect(rendered.toLowerCase()).not.toContain("daily");
		expect(rendered.toLowerCase()).not.toContain("today");
		expect(rendered.toLowerCase()).not.toContain("midnight");
		expect(rendered).not.toContain("Token allowance exhausted for this key");
	});

	it("omits the countdown when no reset instant is known", () => {
		const details = quotaDetails();
		const { resetAtMs: _resetAtMs, ...withoutReset } = details;
		const rendered = texts(formatFallbackExhaustionBlock(withoutReset, NOW));

		expect(rendered).not.toContain("resets in 2h 30m");
		expect(rendered.some(line => line.startsWith("resets in"))).toBe(false);
		expect(rendered).toContain("/model to pick another model");
	});

	it("omits the countdown when the reset instant has already passed", () => {
		const rendered = texts(formatFallbackExhaustionBlock(quotaDetails({ resetAtMs: NOW - 1_000 }), NOW));

		expect(rendered.some(line => line.startsWith("resets in"))).toBe(false);
	});
});

describe("formatFallbackExhaustionBlock — generic case", () => {
	it("titles a mixed failure differently and drops the gateway-admin action", () => {
		const lines = formatFallbackExhaustionBlock(
			{
				tried: [
					{ selector: "local/VIB", triggerClass: "quota", reason: "Token allowance exhausted" },
					{ selector: "openai/gpt-4o-mini", triggerClass: "auth", reason: "401 invalid api key" },
					{ selector: "anthropic/claude-haiku-4-5", triggerClass: "server", reason: "503 overloaded" },
				],
				skipped: [],
				quota: false,
			},
			NOW,
		);

		expect(texts(lines)).toEqual([
			"No model could answer",
			"Models tried:",
			"  local/VIB — token limit reached",
			"  openai/gpt-4o-mini — sign-in rejected",
			"  anthropic/claude-haiku-4-5 — server error",
			"",
			"/model to pick another model",
		]);
	});

	it("prints an unmapped skip code as the code and reports a failed model switch", () => {
		const rendered = texts(
			formatFallbackExhaustionBlock(
				{
					tried: [],
					skipped: [{ selector: "local/VIB", reason: "some_new_resolver_code" }],
					quota: false,
					resolutionFailure: "auth storage unavailable",
				},
				NOW,
			),
		);

		expect(rendered).toContain("  local/VIB — some_new_resolver_code");
		expect(rendered).toContain("Could not switch models:");
		expect(rendered).toContain("  auth storage unavailable");
		expect(rendered[0]).toBe("No model could answer");
	});

	it("keeps every line inside 80 display columns", () => {
		const lines = formatFallbackExhaustionBlock(
			{
				tried: [{ selector: `local/${"v".repeat(200)}`, triggerClass: "quota", reason: "x" }],
				skipped: [{ selector: "local/other", reason: "y".repeat(200) }],
				quota: true,
				resetAtMs: NOW + 60_000,
			},
			NOW,
		);

		for (const line of lines) expect(visibleWidth(line.text)).toBeLessThanOrEqual(78);
	});

	it("narrows an over-long selector and keeps its reason phrase whole", () => {
		const lines = formatFallbackExhaustionBlock(
			{
				tried: [{ selector: `local/${"v".repeat(200)}`, triggerClass: "quota", reason: "x" }],
				skipped: [],
				quota: true,
			},
			NOW,
		);
		const detail = texts(lines).find(line => line.startsWith("  local/"));

		// The phrase is the half that says what happened, so it survives intact
		// and the model id absorbs the loss.
		expect(detail?.endsWith(" — token limit reached")).toBe(true);
		expect(detail).toContain("local/vvv");
		expect(visibleWidth(detail ?? "")).toBeLessThanOrEqual(78);
	});

	it("measures width in display columns, not code units", () => {
		// Wide (CJK) glyphs are two columns each. Counting `String.length` here
		// would pass a line that actually overflows the terminal by ~40 columns.
		const lines = formatFallbackExhaustionBlock(
			{
				tried: [{ selector: `local/${"한".repeat(80)}`, triggerClass: "server", reason: "x" }],
				skipped: [],
				quota: false,
			},
			NOW,
		);
		const detail = texts(lines).find(line => line.startsWith("  local/"));

		expect(visibleWidth(detail ?? "")).toBeLessThanOrEqual(78);
		expect(detail?.endsWith(" — server error")).toBe(true);
	});
});

function createFixture() {
	const showErrorBlock = vi.fn();
	const showError = vi.fn();
	const showWarning = vi.fn();
	const showStatus = vi.fn();
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		pendingTools: new Map(),
		showErrorBlock,
		showError,
		showWarning,
		showStatus,
	} as unknown as InteractiveModeContext;
	return { controller: new EventController(ctx), showErrorBlock, showError, showWarning, showStatus };
}

function noticeEvent(
	overrides: Partial<Extract<AgentSessionEvent, { type: "notice" }>>,
): Extract<AgentSessionEvent, { type: "notice" }> {
	return { type: "notice", level: "error", message: "boom", ...overrides };
}

describe("EventController notice rendering", () => {
	it("renders the block when the exhaustion notice carries its structure", async () => {
		const { controller, showErrorBlock, showError } = createFixture();

		await controller.handleEvent(
			noticeEvent({
				source: "fallback",
				message: "Model fallback chain exhausted; models tried: local/VIB (spent); models skipped: none",
				fallbackExhaustion: quotaDetails({ skipped: [] }),
			}),
		);

		expect(showError).not.toHaveBeenCalled();
		expect(showErrorBlock).toHaveBeenCalledTimes(1);
		const lines = showErrorBlock.mock.calls[0]?.[0] as ErrorBlockLine[];
		expect(lines[0]).toMatchObject({ kind: "title", text: "Token limit reached" });
		expect(texts(lines)).toContain("ask the gateway admin about your key's limit");
		// The single-line form travels with the block: a surface that cannot draw
		// one still has the machine-readable line to print.
		expect(showErrorBlock.mock.calls[0]?.[1]).toBe(
			"fallback: Model fallback chain exhausted; models tried: local/VIB (spent); models skipped: none",
		);
	});

	it("still prints the single prefixed line for a notice without the structure", async () => {
		const { controller, showErrorBlock, showError } = createFixture();

		await controller.handleEvent(
			noticeEvent({ source: "fallback", message: "Model fallback chain exhausted; models tried: none" }),
		);

		expect(showErrorBlock).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith("fallback: Model fallback chain exhausted; models tried: none");
	});

	it("leaves warning and info notices on their existing surfaces", async () => {
		const { controller, showWarning, showStatus, showErrorBlock } = createFixture();

		await controller.handleEvent(noticeEvent({ level: "warning", message: "careful" }));
		await controller.handleEvent(noticeEvent({ level: "info", source: "queue", message: "flushed" }));

		expect(showWarning).toHaveBeenCalledWith("careful");
		expect(showStatus).toHaveBeenCalledWith("queue: flushed");
		expect(showErrorBlock).not.toHaveBeenCalled();
	});
});

describe("UiHelpers.showErrorBlock on a backgrounded session", () => {
	function captureStderr(run: () => void): string {
		const written: string[] = [];
		const original = process.stderr.write;
		process.stderr.write = ((chunk: unknown) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			run();
		} finally {
			process.stderr.write = original;
		}
		return written.join("");
	}

	it("writes the contract line first, then the block", () => {
		const helpers = new UiHelpers({ isBackgrounded: true } as unknown as InteractiveModeContext);
		const plainMessage =
			"fallback: Model fallback chain exhausted; models tried: local/VIB (spent); models skipped: none";

		const output = captureStderr(() => {
			helpers.showErrorBlock(formatFallbackExhaustionBlock(quotaDetails({ skipped: [] }), NOW), plainMessage);
		});

		const lines = output.split("\n");
		// Regression guard: the block must never REPLACE the machine-readable line
		// on a surface that is read by logs and scraped by tooling.
		expect(lines[0]).toBe(`Error: ${plainMessage}`);
		expect(lines[1]).toBe("Token limit reached");
		expect(lines).toContain("  local/VIB — token limit reached");
		expect(lines).toContain("/model to pick another model");
		// Plain text only: no theme escape codes reach a redirected stream.
		expect(output).not.toContain("[");
	});

	it("writes nothing at all for an empty block", () => {
		const helpers = new UiHelpers({ isBackgrounded: true } as unknown as InteractiveModeContext);

		expect(captureStderr(() => helpers.showErrorBlock([], "unused"))).toBe("");
	});
});
