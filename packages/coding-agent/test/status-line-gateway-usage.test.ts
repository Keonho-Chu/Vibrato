import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { StatusLineComponent } from "../src/modes/components/tool-status-header";
import { initTheme } from "../src/modes/theme/theme";
import type { AgentSession } from "../src/session/agent-session";
import { type GatewayQuotaKey, GatewayQuotaObserver } from "../src/session/gateway-quota-observer";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const AT = Date.now();

function key(provider: string): GatewayQuotaKey {
	return { provider, baseUrl: "https://gateway.internal/v1", credentialId: "s", sessionId: "s" };
}

interface SessionOptions {
	observer?: GatewayQuotaObserver;
	fetchUsageReports?: () => Promise<unknown>;
}

function makeSession(options: SessionOptions = {}): AgentSession {
	const usageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 };
	const observer = options.observer;
	return {
		state: { messages: [], model: { id: "local/VIB", contextWindow: 200_000 } },
		messages: [],
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		model: { id: "local/VIB", contextWindow: 200_000 },
		modelRegistry: { isUsingOAuth: () => false },
		isStreaming: false,
		isFastModeActive: () => false,
		fetchUsageReports: options.fetchUsageReports,
		get gatewayQuotaState() {
			return observer?.state ?? null;
		},
		sessionManager: {
			getUsageStatistics: () => usageStats,
			getSessionName: () => undefined,
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
	} as unknown as AgentSession;
}

/** An observer holding one success response with the given budget. */
function servedGateway(provider: string, limit: number, remaining: number, resetAt?: number): GatewayQuotaObserver {
	const observer = new GatewayQuotaObserver();
	observer.observe({
		key: key(provider),
		kind: "success",
		status: 200,
		headers: {
			"x-vug-daily-limit": String(limit),
			"x-vug-daily-remaining": String(remaining),
			...(resetAt === undefined ? {} : { "x-vug-daily-reset": String(resetAt) }),
		},
		at: AT,
	});
	return observer;
}

function usageOnly(session: AgentSession, segmentOptions?: Record<string, unknown>): StatusLineComponent {
	const component = new StatusLineComponent(session);
	component.updateSettings({
		preset: "custom",
		leftSegments: [],
		rightSegments: ["usage"],
		showSkillHud: false,
		...(segmentOptions ? { segmentOptions } : {}),
	});
	return component;
}

async function waitFor(component: StatusLineComponent, pattern: RegExp, width = 120): Promise<string> {
	let text = "";
	for (let i = 0; i < 20; i++) {
		text = stripAnsi(component.getTopBorder(width).content);
		if (pattern.test(text)) return text;
		await Bun.sleep(10);
	}
	return text;
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

describe("status line gateway usage window", () => {
	it("renders the used share of the gateway quota window", () => {
		const component = usageOnly(makeSession({ observer: servedGateway("vug", 1000, 250) }));

		const text = stripAnsi(component.getTopBorder(120).content);

		expect(text).toContain("vug 75%");
		component.dispose();
	});

	it("inverts the share in remaining mode", () => {
		const component = usageOnly(makeSession({ observer: servedGateway("vug", 1000, 250) }), {
			usage: { mode: "remaining" },
		});

		const text = stripAnsi(component.getTopBorder(120).content);

		expect(text).toContain("vug 25%");
		expect(text).not.toContain("75%");
		component.dispose();
	});

	it("shows a reset only when the gateway sent one", () => {
		const withReset = usageOnly(makeSession({ observer: servedGateway("vug", 1000, 250, AT + 90 * 60_000) }));
		const withoutReset = usageOnly(makeSession({ observer: servedGateway("vug", 1000, 250) }));

		expect(stripAnsi(withReset.getTopBorder(120).content)).toContain("vug 75% (1h 30m)");
		expect(stripAnsi(withoutReset.getTopBorder(120).content)).toContain("vug 75%");
		expect(stripAnsi(withoutReset.getTopBorder(120).content)).not.toContain("(");
		withReset.dispose();
		withoutReset.dispose();
	});

	it("hides the segment entirely for a provider that never sent a gateway header", () => {
		const component = usageOnly(makeSession({ observer: new GatewayQuotaObserver() }));

		const text = stripAnsi(component.getTopBorder(120).content);

		expect(text).not.toContain("vug");
		expect(text).not.toContain("0%");
		expect(text).not.toContain("free");
		component.dispose();
	});

	it("says the limit is reached and when it resets after a 429", () => {
		const observer = new GatewayQuotaObserver();
		observer.observe({
			key: key("vug"),
			kind: "failure",
			status: 429,
			headers: {
				"x-vug-daily-limit": "1000",
				"x-vug-daily-used": "1000",
				"x-vug-daily-reset": String(AT + 11 * 3_600_000),
			},
			at: AT,
		});
		const component = usageOnly(makeSession({ observer }));

		const text = stripAnsi(component.getTopBorder(120).content);

		expect(text).toContain("vug 100% (11h) limit reached");
		component.dispose();
	});

	it("reads correctly for a short quota window, not just a day-long one", () => {
		// Production runs a three-hour window. Nothing may assume a longer one:
		// the countdown comes from the gateway's own reset instant, so a window
		// of any length renders the same way.
		const served = usageOnly(makeSession({ observer: servedGateway("vug", 90_000, 22_500, AT + 40 * 60_000) }));
		const observer = new GatewayQuotaObserver();
		observer.observe({
			key: key("vug"),
			kind: "failure",
			status: 429,
			headers: {
				"x-vug-daily-limit": "90000",
				"x-vug-daily-used": "90000",
				"x-vug-daily-reset": String(AT + 165 * 60_000),
			},
			at: AT,
		});
		const exhausted = usageOnly(makeSession({ observer }));

		expect(stripAnsi(served.getTopBorder(120).content)).toContain("vug 75% (40m)");
		expect(stripAnsi(exhausted.getTopBorder(120).content)).toContain("vug 100% (2h 45m) limit reached");
		served.dispose();
		exhausted.dispose();
	});

	it("says the gateway is congested and how deep the queue is after a 503", () => {
		const observer = new GatewayQuotaObserver();
		observer.observe({
			key: key("vug"),
			kind: "failure",
			status: 503,
			headers: { "x-vug-queue-depth": "12", "x-vug-inflight": "4", "retry-after": "5" },
			at: AT,
		});
		const component = usageOnly(makeSession({ observer }));

		const text = stripAnsi(component.getTopBorder(120).content);

		expect(text).toContain("vug busy queue 12");
		// No budget was ever observed, so no percentage is drawn.
		expect(text).not.toMatch(/vug[^│]*\d+%/);
		component.dispose();
	});

	it("keeps the observed budget alongside a congestion note", () => {
		const observer = servedGateway("vug", 1000, 250);
		observer.observe({
			key: key("vug"),
			kind: "failure",
			status: 503,
			headers: { "x-vug-queue-depth": "3" },
			at: AT + 1000,
		});
		const component = usageOnly(makeSession({ observer }));

		const text = stripAnsi(component.getTopBorder(120).content);

		expect(text).toContain("vug 75% busy queue 3");
		component.dispose();
	});

	it("renders a Korean gateway label without mangling it", () => {
		const component = usageOnly(makeSession({ observer: servedGateway("사내게이트웨이", 1000, 400) }));

		const text = stripAnsi(component.getTopBorder(120).content);

		expect(text).toContain("사내게이트웨이 60%");
		component.dispose();
	});

	it("drops the usage segment before context_pct on a narrow terminal", () => {
		const session = makeSession({ observer: servedGateway("vug", 1000, 250, AT + 90 * 60_000) });
		const component = new StatusLineComponent(session);
		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: ["context_pct", "usage"],
			showSkillHud: false,
		});

		const wide = stripAnsi(component.getTopBorder(120).content);
		const narrow = stripAnsi(component.getTopBorder(16).content);

		expect(wide).toContain("vug 75% (1h 30m)");
		expect(narrow).not.toContain("vug");
		component.dispose();
	});
});

describe("default-usage preset with a gateway", () => {
	it("shows the OAuth window and the gateway window side by side", async () => {
		const now = Date.now();
		const session = makeSession({
			observer: servedGateway("vug", 1000, 250, now + 90 * 60_000),
			fetchUsageReports: async () => [
				{
					provider: "anthropic",
					fetchedAt: now,
					limits: [
						{
							id: "anthropic:5h",
							scope: { provider: "anthropic", windowId: "5h" },
							window: { id: "5h", resetsAt: now + 180 * 60_000 },
							amount: { usedFraction: 0.24, unit: "percent" },
						},
					],
				},
			],
		});
		const component = new StatusLineComponent(session);
		component.updateSettings({ preset: "default-usage", showSkillHud: false });

		const text = await waitFor(component, /5h 24%/, 200);

		expect(text).toContain("5h 24% (3h)");
		expect(text).toContain("vug 75% (1h 30m)");
		// The two windows are distinct entries, not one run-together label.
		expect(text).not.toContain("(3h)vug");
		expect(text.indexOf("5h 24%")).toBeLessThan(text.indexOf("vug 75%"));
		component.dispose();
	});
});
