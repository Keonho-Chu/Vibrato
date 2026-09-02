import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "../src/modes/components/status-line/segments";
import { renderSegment } from "../src/modes/components/status-line/segments";
import { EMPTY_JOBS_SNAPSHOT } from "../src/modes/jobs-observer";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function createCtx(usage: Partial<SegmentContext["usageStats"]>): SegmentContext {
	return {
		session: {
			state: {},
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: undefined,
		} as unknown as SegmentContext["session"],
		width: 120,
		options: {},
		planMode: null,
		goalMode: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
			...usage,
		},
		contextPercent: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		jobs: EMPTY_JOBS_SNAPSHOT,
		sessionStartTime: Date.now(),
		git: {
			branch: null,
			status: null,
			pr: null,
		},
		usage: null,
	};
}

describe("issue #953 cache status line icons", () => {
	it("renders cache reads as cache output and cache writes as cache input", () => {
		const cacheRead = renderSegment("cache_read", createCtx({ cacheRead: 28_919_910 }));
		const cacheWrite = renderSegment("cache_write", createCtx({ cacheWrite: 1_759_992 }));

		// The segments now say what they are in words: the issue was that the
		// arrow glyphs did not tell a reader which direction was which.
		expect(cacheRead.visible).toBe(true);
		expect(cacheRead.content).toContain("cache read");
		expect(cacheRead.content).not.toContain("cache write");

		expect(cacheWrite.visible).toBe(true);
		expect(cacheWrite.content).toContain("cache write");
		expect(cacheWrite.content).not.toContain("cache read");
	});
});
