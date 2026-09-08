import { describe, expect, test } from "bun:test";
import {
	EXECUTION_SHOWCASE_STATES,
	EXECUTION_SHOWCASE_VIEWPORTS,
	type ExecutionShowcaseState,
	renderExecutionShowcase,
} from "./fixtures/tui/execution-status-showcase";

const EXPECTED_LABEL: Record<ExecutionShowcaseState, string | undefined> = {
	idle: undefined,
	model: "Waiting for model",
	response: "Receiving response",
	tool: "Running tools",
	"parallel-tools": "Running tools",
	"tool-failure": "Running tools",
	retry: "Waiting to retry",
	compaction: "Context maintenance",
	input: "Waiting for input",
	background: "Background work",
	queued: "Messages queued",
	"long-cjk": "Running tools",
};

describe("execution summary production-root showcase", () => {
	for (const state of EXECUTION_SHOWCASE_STATES) {
		for (const viewport of EXECUTION_SHOWCASE_VIEWPORTS) {
			test(`${state} stays pinned at ${viewport.columns}x${viewport.rows} across history`, async () => {
				const frames = await renderExecutionShowcase(state, viewport);
				for (const frame of frames) {
					expect(frame.focusedComposer).toBe(true);
					expect(frame.pinnedStatus).toBe(true);
					for (const row of frame.summaryRows) {
						expect(Bun.stringWidth(row)).toBeLessThanOrEqual(viewport.columns);
						if (row) expect(frame.terminalText).toContain(row);
					}
					const label = EXPECTED_LABEL[state];
					if (label) expect(frame.terminalText).toContain(label);
					else expect(frame.terminalText).not.toContain("Waiting for model");
					// Text-only accessibility probe, not a claim that the existing theme honors NO_COLOR.
					expect(Bun.stripANSI(frame.terminalAnsi)).toBe(frame.terminalText);
					expect(frame.terminalText).toContain("계속 진행");
				}
				expect(frames[0]!.terminalText).toContain("Transcript 100:");
				expect(frames[2]!.terminalText).toContain("Transcript 1:");
				expect(frames[1]!.terminalText).not.toBe(frames[0]!.terminalText);
			}, 15_000);
		}
	}
});
