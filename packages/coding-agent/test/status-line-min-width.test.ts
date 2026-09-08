import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@vib-rato/tui";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { FooterComponent } from "../src/modes/components/footer";
import { shortenModelId } from "../src/modes/components/status-line/model-name";
import { StatusLineComponent } from "../src/modes/components/tool-status-header";
import { initTheme, theme } from "../src/modes/theme/theme";
import type { AgentSession } from "../src/session/agent-session";
import { GatewayQuotaObserver } from "../src/session/gateway-quota-observer";

const CONTEXT_WINDOW = 200_000;
const MODEL_ID = "anthropic/claude-sonnet-4-5-20250929";

const strip = (value: string): string => Bun.stripANSI(value);

interface SessionOverrides {
	percent?: number | null;
	goalStatus?: "active" | "paused" | "complete" | "dropped";
	modelId?: string;
}

function createSession(overrides: SessionOverrides = {}) {
	const percent = overrides.percent === undefined ? 18.3 : overrides.percent;
	return {
		state: {
			messages: [],
			model: { id: overrides.modelId ?? MODEL_ID, contextWindow: CONTEXT_WINDOW },
		},
		isStreaming: false,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getCurrentModel: () => undefined,
		isFastModeEnabled: () => false,
		isFastModeActive: () => false,
		getContextUsage: () => ({ percent, contextWindow: CONTEXT_WINDOW }),
		getGoalModeState: () => ({ goal: { status: overrides.goalStatus ?? "active", tokensUsed: 12_345 } }),
		settings: { get: () => false },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "MinWidth",
			getUsageStatistics: () => ({
				input: 1000,
				output: 500,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0.5,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

/** Default-preset-shaped rail: context % rides inside `model`, goal rides in `mode`. */
function buildRail(overrides: SessionOverrides = {}, goalActive = true): StatusLineComponent {
	const component = new StatusLineComponent(createSession(overrides), { version: "9.9.9" });
	component.updateSettings({
		preset: "custom",
		leftSegments: ["model", "mode", "git", "path"],
		rightSegments: ["session_name", "cost"],
		separator: "slash",
		showSkillHud: false,
		showActionHints: false,
		sessionAccent: false,
		maxRows: 1,
	});
	component.setGoalModeStatus(goalActive ? { enabled: true, paused: false } : undefined);
	return component;
}

/**
 * A rail wide enough to need the normal eviction path rather than the priority
 * row, built only from segments whose width is fixed by the fixture. No `git`
 * or `path`: their widths come from the checkout, which decides whether the
 * rail overflows at all.
 */
function overflowingRail(): StatusLineComponent {
	const session = createSession() as unknown as Record<string, unknown>;
	(session.sessionManager as { getUsageStatistics: () => unknown }).getUsageStatistics = () => ({
		input: 1000,
		output: 500,
		cacheRead: 8200,
		cacheWrite: 1200,
		premiumRequests: 0,
		cost: 0.5,
	});

	const component = new StatusLineComponent(
		session as unknown as ConstructorParameters<typeof StatusLineComponent>[0],
		{ version: "9.9.9" },
	);
	component.updateSettings({
		preset: "custom",
		leftSegments: ["model", "mode"],
		rightSegments: ["session_name", "token_in", "token_out", "cache_read", "cache_write", "cost"],
		separator: "slash",
		showSkillHud: false,
		showActionHints: false,
		sessionAccent: false,
		maxRows: 1,
	});
	component.setGoalModeStatus({ enabled: true, paused: false });
	return component;
}

const CONTEXT_TOKEN = /\d+(?:\.\d+)?%/;

/**
 * Ceiling for the width-sweep tests. Not a slow-assertion allowance: each
 * iteration builds a fresh component on purpose, since a cold git cache is what
 * keeps the sweep deterministic, and every construction issues the
 * unconditional branch and status lookups in `#buildSegmentContext`. Over a
 * hundred-odd widths that is a hundred-odd git subprocesses, which a CI runner
 * walks far more slowly than a laptop; bun's 5s default killed them mid-sweep.
 */
const SWEEP_TIMEOUT_MS = 60_000;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

describe("shortenModelId", () => {
	it.each([
		["anthropic/claude-sonnet-4-5-20250929", "sonnet-4.5"],
		["claude-opus-4-1-20250805", "opus-4.1"],
		["openai/gpt-4o-2024-05-13", "gpt-4o"],
		["gpt-5.1-codex", "gpt-5.1-codex"],
		["google/gemini-3-pro", "gemini-3-pro"],
		["openrouter/anthropic/claude-haiku-4-5", "haiku-4.5"],
		["qwen2.5:7b", "qwen2.5:7b"],
		["llama3", "llama3"],
	])("shortens %s to %s", (input, expected) => {
		expect(shortenModelId(input)).toBe(expected);
	});

	it.each([
		"",
		"   ",
		"20250929",
		"anthropic/",
		"claude-",
		"-20250929",
	])("never returns an empty label for %p", input => {
		expect(shortenModelId(input).length).toBeGreaterThan(0);
	});

	it("falls back to a stable label when the id is missing", () => {
		expect(shortenModelId(undefined)).toBe("no-model");
		expect(shortenModelId(null)).toBe("no-model");
	});
});

describe("status rail survives very small widths", () => {
	it(
		"keeps a context percentage at every width from 4 to 120",
		() => {
			for (let width = 4; width <= 120; width += 1) {
				const rendered = buildRail().render(width);
				const text = strip(rendered.join(" "));

				expect({ width, text }).toMatchObject({ text: expect.stringMatching(CONTEXT_TOKEN) });
				for (const row of rendered) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			}
		},
		SWEEP_TIMEOUT_MS,
	);

	it(
		"never drops the model before the goal, nor the goal before the context",
		() => {
			const goalGlyph = theme.icon.goal || "G";
			const modelName = shortenModelId(MODEL_ID);

			for (let width = 4; width <= 120; width += 1) {
				const text = strip(buildRail().render(width).join(" "));
				const hasContext = CONTEXT_TOKEN.test(text);
				const hasGoal = text.includes(goalGlyph) || text.includes("Goal");
				const hasModel = text.includes(modelName);

				// Priority order is an invariant of every width, not just the narrow end.
				expect({ width, ok: hasContext || !hasGoal }).toEqual({ width, ok: true });
				expect({ width, ok: hasGoal || !hasModel }).toEqual({ width, ok: true });
			}
		},
		SWEEP_TIMEOUT_MS,
	);

	it(
		"suppresses the overflow marker once the rail is narrow",
		() => {
			for (let width = 4; width <= 30; width += 1) {
				expect(strip(buildRail().render(width).join(" "))).not.toContain("…+");
			}
		},
		SWEEP_TIMEOUT_MS,
	);

	it("keeps the context window while it fits and falls back to an integer percentage", () => {
		const wide = strip(buildRail().render(28).join(" "));
		const narrow = strip(buildRail().render(5).join(" "));

		expect(wide).toContain("18.3%/200K");
		expect(narrow).toBe("18%");
	});

	it("renders exact rows at representative widths", () => {
		const goalGlyph = theme.icon.goal || "G";
		const goalLabel = theme.icon.goal ? `${theme.icon.goal} Goal` : "Goal";
		const modelGlyph = theme.icon.model || "s";

		expect(strip(buildRail().render(4)[0])).toBe("18%");
		expect(strip(buildRail().render(12)[0])).toBe(`18%·${goalGlyph}·${modelGlyph}`);
		expect(strip(buildRail().render(24)[0])).toBe(`18.3%/200K·${goalGlyph}·sonnet-4.5`);
		expect(strip(buildRail().render(30)[0])).toBe(`18.3%/200K·${goalLabel}·sonnet-4.5`);
		// A rail that overflows at 80 yet is far too wide for the priority row:
		// normal eviction has to handle it, dropping telemetry from the tail and
		// drawing the overflow marker.
		//
		// Deliberately built from fixed-width segments only. Upstream used `git`
		// and `path`, whose widths come from the checkout — the branch name and
		// working directory of whoever runs the test — so whether this case
		// overflowed at all depended on where the repo happened to sit.
		const wide = strip(overflowingRail().render(80)[0]);
		const roomy = strip(overflowingRail().render(200)[0]);

		// It really overflows at 80 and really does not at 200.
		expect(wide).toContain("…+");
		expect(roomy).not.toContain("…+");
		// The priority row draws neither a session name nor an overflow marker,
		// so this is the normal rail evicting normally.
		expect(wide).toContain("MinWidth");
		expect(wide).toContain("sonnet-4.5");
		expect(wide).toContain("18.3%");
		expect(wide).toContain("Goal");
		// Tail telemetry is what paid for the fit.
		expect(roomy).toContain("cache write 1.2K");
		expect(roomy).toContain("$0.50");
		expect(wide).not.toContain("cache write 1.2K");
		expect(wide).not.toContain("$0.50");
	});

	it("keeps the goal glyph in its status color", () => {
		const pausedRow = buildRail({ goalStatus: "paused" }).render(12)[0];
		const activeRow = buildRail({ goalStatus: "active" }).render(12)[0];

		expect(pausedRow).toContain(theme.getFgAnsi("warning"));
		expect(pausedRow).not.toEqual(activeRow);
	});

	it("still shows an unknown context percentage rather than nothing", () => {
		const row = strip(buildRail({ percent: null }).render(10).join(" "));
		expect(row.startsWith("?")).toBe(true);
	});

	it("leaves the rail to the normal overflow marker when there is no context or goal", () => {
		const component = new StatusLineComponent(
			{
				state: { messages: [] },
				isStreaming: false,
				getAsyncJobSnapshot: () => ({ running: [] }),
				isFastModeActive: () => false,
				modelRegistry: { isUsingOAuth: () => false },
				sessionManager: {
					getSessionName: () => "NoCtx",
					getUsageStatistics: () => ({
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						premiumRequests: 0,
						cost: 0,
					}),
				},
			} as unknown as ConstructorParameters<typeof StatusLineComponent>[0],
			{ version: "9.9.9" },
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["vibrato", "session"],
			rightSegments: ["session_name", "time"],
			separator: "pipe",
			showSkillHud: false,
			showActionHints: false,
			sessionAccent: false,
			maxRows: 1,
		});

		expect(strip(component.render(3)[0])).toContain("…");
	});
});

describe("gateway quota window on a narrow rail", () => {
	/** An observer holding one served gateway response, 75% of the budget spent. */
	function servedObserver(): GatewayQuotaObserver {
		const observer = new GatewayQuotaObserver();
		observer.observe({
			key: { provider: "vllm", baseUrl: "https://gateway.internal/v1", credentialId: "c", sessionId: "s" },
			kind: "success",
			status: 200,
			headers: { "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "250" },
		});
		return observer;
	}

	/**
	 * A rail whose model declares no context window and whose session has no
	 * goal, so nothing on it carried an eviction rank before the gateway window
	 * existed. `observed` decides whether the gateway ever answered.
	 *
	 * `model` sits at the tail of one group on purpose. Eviction scans the right
	 * group before the left and each from its tail, so a model anywhere earlier
	 * outlives the counters on scan order alone and its rank cannot be observed.
	 * At the tail, rank is the only thing keeping it.
	 */
	function buildNoContextRail(observed: boolean): StatusLineComponent {
		const observer = observed ? servedObserver() : new GatewayQuotaObserver();
		const session = createSession() as unknown as Record<string, unknown>;
		(session.state as { model: { contextWindow: number } }).model.contextWindow = 0;
		session.getContextUsage = () => undefined;
		session.getGoalModeState = () => undefined;
		Object.defineProperty(session, "gatewayQuotaState", { get: () => observer.state });

		const component = new StatusLineComponent(
			session as unknown as ConstructorParameters<typeof StatusLineComponent>[0],
			{},
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: ["token_in", "token_out", "model", "usage"],
			separator: "slash",
			segmentOptions: { usage: { windows: "gateway" } },
			showSkillHud: false,
			showActionHints: false,
			sessionAccent: false,
			maxRows: 1,
		});
		return component;
	}

	/** A rail carrying the token/cache counters and the gateway usage window. */
	function buildUsageRail(): StatusLineComponent {
		const observer = new GatewayQuotaObserver();
		observer.observe({
			key: { provider: "vllm", baseUrl: "https://gateway.internal/v1", credentialId: "c", sessionId: "s" },
			kind: "success",
			status: 200,
			headers: { "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "250" },
		});
		const session = createSession() as unknown as Record<string, unknown>;
		Object.defineProperty(session, "gatewayQuotaState", { get: () => observer.state });
		(session.sessionManager as { getUsageStatistics: () => unknown }).getUsageStatistics = () => ({
			input: 1000,
			output: 500,
			cacheRead: 8200,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0.5,
		});

		const component = new StatusLineComponent(
			session as unknown as ConstructorParameters<typeof StatusLineComponent>[0],
			{ version: "9.9.9" },
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: ["token_in", "token_out", "cache_read", "usage", "cost"],
			separator: "slash",
			segmentOptions: { usage: { windows: "gateway" } },
			showSkillHud: false,
			showActionHints: false,
			sessionAccent: false,
			maxRows: 1,
		});
		return component;
	}

	it(
		"drops the token and cache counters before the quota window",
		() => {
			const wide = strip(buildUsageRail().render(120)[0]);
			expect(wide).toContain("vug 75%");
			expect(wide).toContain("in 1K");
			expect(wide).toContain("cache read 8.2K");

			// A counter says what has been spent; the window says how much is left
			// before the gateway stops answering. On a rail with room for one, the
			// window is the one worth keeping.
			let sawWindowWithoutCounters = false;
			for (let width = 20; width <= 60; width += 1) {
				const row = strip(buildUsageRail().render(width)[0]);
				const hasWindow = row.includes("vug");
				const hasCounter = row.includes("in 1K") || row.includes("out 500") || row.includes("cache read");
				// Never the inversion: a counter surviving a dropped window.
				expect({ width, ok: hasWindow || !hasCounter }).toEqual({ width, ok: true });
				if (hasWindow && !hasCounter) sawWindowWithoutCounters = true;
			}
			expect(sawWindowWithoutCounters).toBe(true);
		},
		SWEEP_TIMEOUT_MS,
	);

	it("also lets the model outlive the counters on a rail that had no ranking at all", () => {
		// A model declaring no context window, with no goal running, behind a
		// gateway that has reported a budget. That rail ranked nothing before,
		// so `model` sat at 0 with the counters and went in tail order; the
		// rendered window switches ranking on and lifts it to 1. This is the one
		// case where the window widens something other than itself, and it is
		// the deployment the window exists for: a self-hosted model served
		// through the gateway.
		const withGateway = strip(buildNoContextRail(true).render(28)[0]);
		const withoutGateway = strip(buildNoContextRail(false).render(28)[0]);

		// Ranked: the counters pay for the model and the window.
		expect(withGateway).toContain("sonnet-4.5");
		expect(withGateway).not.toContain("in 1K");
		expect(withGateway).not.toContain("out 500");
		// Unranked: the same layout at the same width evicts from the tail, and
		// the model is what sits there.
		expect(withoutGateway).toContain("in 1K");
		expect(withoutGateway).toContain("out 500");
		expect(withoutGateway).not.toContain("sonnet-4.5");
		expect(withoutGateway).not.toContain("vug");
	});

	it("carries no priority when the segment has observed nothing", () => {
		// Without an observation the segment renders nothing, so eviction must be
		// the plain tail-first order it has always been.
		const component = new StatusLineComponent(createSession(), { version: "9.9.9" });
		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: ["token_in", "usage", "cost"],
			separator: "slash",
			segmentOptions: { usage: { windows: "gateway" } },
			showSkillHud: false,
			showActionHints: false,
			sessionAccent: false,
			maxRows: 1,
		});

		const row = strip(component.render(20)[0]);

		expect(row).not.toContain("vug");
		expect(row).not.toContain("0%");
	});
});

describe("footer model name", () => {
	it("renders the shortened model name instead of the raw id", () => {
		const footer = new FooterComponent(createSession() as unknown as AgentSession);
		const text = footer.render(120).map(strip).join("\n");

		expect(text).toContain("sonnet-4.5");
		expect(text).not.toContain(MODEL_ID);
	});
});
