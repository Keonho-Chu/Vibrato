import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@vib-rato/tui";
import { resolveWelcomeIntroTickMs, WelcomeComponent } from "../src/modes/components/welcome";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";

const originalBuildChannel = process.env.VIB_BUILD_CHANNEL;

afterEach(() => {
	if (originalBuildChannel === undefined) {
		delete process.env.VIB_BUILD_CHANNEL;
	} else {
		process.env.VIB_BUILD_CHANNEL = originalBuildChannel;
	}
});
beforeAll(async () => {
	const theme = await getThemeByName("lig-blue");
	if (!theme) throw new Error("Failed to load lig-blue theme");
	setThemeInstance(theme);
});

/** Top and bottom rows of the rounded block-letter `vib` mark. */
const MARK_TOP = "╭──╮        ╭──╮  ╭────╮  ╭───────╮";
const MARK_BOTTOM = "╰──────╯      ╰────╯  ╰───────╯";
/** Rows the mark occupies, and the narrowest terminal that can hold it whole. */
const MARK_ROWS = 6;
const MARK_MIN_WIDTH = 41; // 2-column border + 3-column indent + 36-column mark
/** Rows the border costs: the title rail and the bottom edge. */
const BORDER_ROWS = 2;
/** Rows of the full tier: the border, the mark, and nine surrounding rows. */
const FULL_TIER_ROWS = BORDER_ROWS + MARK_ROWS + 9;
/** Rows of the widest markless tier, border included. */
const MARKLESS_TIER_ROWS = BORDER_ROWS + 8;
/** Index of the first content row: everything below the title rail. */
const FIRST_CONTENT_ROW = 1;
/** Index of the mark's first row, and of the identity row under it. */
const MARK_START = FIRST_CONTENT_ROW + 1;
const IDENTITY_ROW = MARK_START + MARK_ROWS + 1;
/** Duration of one full rotation of the gradient; the sweep loops on it. */
const SWEEP_PERIOD_MS = 2000;
// `shortenPath` abbreviates against the real home directory, so anchor there.
const CWD = path.join(os.homedir(), "Documents", "GitHub", "LGJ", "gajae-code");

function stripRenderControls(line: string): string {
	return stripVTControlCharacters(line);
}

function welcome(options: ConstructorParameters<typeof WelcomeComponent>[5] = {}): WelcomeComponent {
	return new WelcomeComponent("1.2.3", "qwen3-coder-30b", "vllm", [], "unicode", { cwd: CWD, ...options });
}

/** The six rendered rows the mark occupies. */
function markRows(lines: string[]): string[] {
	return lines.slice(MARK_START, MARK_START + MARK_ROWS);
}

function plain(component: WelcomeComponent, width: number): string[] {
	return component.render(width).map(stripRenderControls);
}

/** Strip the border from a rendered surface, returning just the content column. */
function body(lines: string[]): string[] {
	return lines.slice(1, -1).map(line => line.slice(1, -1));
}

/** Assert the box is closed and every row is exactly `width` columns. */
function expectClosedBox(lines: string[], width: number): void {
	expect(lines.length).toBeGreaterThanOrEqual(3);
	expect(lines[0]).toStartWith("╭");
	expect(lines[0]).toEndWith("╮");
	expect(lines.at(-1)).toBe(`╰${"─".repeat(width - 2)}╯`);
	for (const line of lines.slice(1, -1)) {
		expect(line).toStartWith("│");
		expect(line).toEndWith("│");
	}
	for (const line of lines) expect(visibleWidth(line)).toBe(width);
}

/** Run `body` with `performance.now()` pinned to a clock the caller advances. */
function withFakeClock<T>(body: (setNow: (ms: number) => void) => T): T {
	const original = performance.now.bind(performance);
	let now = 0;
	(performance as unknown as { now: () => number }).now = () => now;
	try {
		return body(ms => {
			now = ms;
		});
	} finally {
		(performance as unknown as { now: () => number }).now = original;
	}
}

/** Record the delays of every interval opened while `body` runs. */
function recordIntervals<T>(body: () => T): { result: T; delays: number[]; clears: number } {
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	const delays: number[] = [];
	let clears = 0;
	globalThis.setInterval = ((handler: () => void, delay?: number, ...args: unknown[]) => {
		delays.push(Number(delay));
		return Reflect.apply(originalSetInterval, globalThis, [handler, delay, ...args]);
	}) as typeof globalThis.setInterval;
	globalThis.clearInterval = ((handle: Parameters<typeof globalThis.clearInterval>[0]) => {
		clears += 1;
		return Reflect.apply(originalClearInterval, globalThis, [handle]);
	}) as typeof globalThis.clearInterval;
	try {
		const result = body();
		return { result, delays, clears };
	} finally {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	}
}

describe("welcome launch surface", () => {
	it("renders a bordered box with the mark, the identity line, model and workspace", () => {
		const lines = plain(welcome({ buildLabel: "release build" }), 80);

		expectClosedBox(lines, 80);
		// The version rides the title rail, not a content row.
		expect(lines[0]).toStartWith("╭─── vib v1.2.3 · release build ───");
		expect(lines[MARK_START]).toContain(MARK_TOP);
		expect(lines[MARK_START + MARK_ROWS - 1]).toContain(MARK_BOTTOM);
		expect(lines[IDENTITY_ROW]).toStartWith("│   Vibrato · LIG System");

		const text = lines.join("\n");
		expect(text).toContain("qwen3-coder-30b · vllm");
		expect(text).toContain("~/Documents/GitHub/LGJ/gajae-code");
		expect(text).toContain("No LSP servers");
	});

	it("blank-pads the content column inside the border", () => {
		const rows = body(plain(welcome(), 80));

		// Top and bottom breathing room, and a blank between each information group.
		expect(rows[0]?.trim()).toBe("");
		expect(rows.at(-1)?.trim()).toBe("");
		expect(rows[MARK_ROWS + 1]?.trim()).toBe("");
	});

	it("drops the brand rule the markless screen leaned on", () => {
		// The mark and the border carry the brand now, so no rule and no
		// plain-text wordmark sit beside them.
		expect(plain(welcome(), 80).join("\n")).not.toContain("▌");
	});

	it("sweeps the mark one glyph at a time, driven by a single timer", () => {
		const component = welcome();
		const { delays } = recordIntervals(() => {
			let renders = 0;
			component.playIntro(() => {
				renders += 1;
			});
			expect(renders).toBeGreaterThanOrEqual(1);
		});
		try {
			// Exactly one timer drives the sweep, at the resolved cadence.
			expect(delays).toEqual([resolveWelcomeIntroTickMs()]);

			const swept = component.render(120);
			// Every glyph of the mark carries its own colour escape, so the mark
			// rows alone emit escapes by the hundred.
			const markEscapes =
				markRows(swept)
					.join("")
					.match(/\x1b\[38;/g)?.length ?? 0;
			expect(markEscapes).toBeGreaterThan(100);
		} finally {
			component.dispose();
		}
		// `dispose()` clears the timer and drops the surface back to the rest frame.
		expect(component.render(120)).toEqual(welcome().render(120));
	});

	it("loops forever instead of settling after one pass", () => {
		withFakeClock(setNow => {
			const component = welcome();
			try {
				component.playIntro(() => {});
				const resting = markRows(welcome().render(120));

				// Well past the old three-second intro, the mark is still moving and
				// has not fallen back to the resting frame.
				for (const t of [SWEEP_PERIOD_MS, 3_000, 10_000, 120_000]) {
					setNow(t + 500);
					expect(markRows(component.render(120))).not.toEqual(resting);
				}

				// And consecutive ticks keep differing: it is animating, not frozen
				// on some late frame.
				setNow(60_000);
				const a = markRows(component.render(120));
				setNow(60_000 + resolveWelcomeIntroTickMs());
				expect(markRows(component.render(120))).not.toEqual(a);
			} finally {
				component.dispose();
			}
		});
	});

	it("wraps the loop seam without a jump", () => {
		withFakeClock(setNow => {
			const component = welcome();
			try {
				component.playIntro(() => {});
				const frameAt = (t: number) => {
					setNow(t);
					return markRows(component.render(120)).join("");
				};

				// The animation is exactly periodic: one period on is the same frame.
				expect(frameAt(SWEEP_PERIOD_MS)).toBe(frameAt(0));
				expect(frameAt(SWEEP_PERIOD_MS * 3)).toBe(frameAt(0));

				// And the step across the seam is no larger than a step mid-cycle,
				// so the wrap is not a visible jerk.
				const tick = resolveWelcomeIntroTickMs();
				const differingGlyphs = (a: string, b: string) => {
					const at = [...a.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)];
					const bt = [...b.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)];
					let worst = 0;
					for (let i = 0; i < at.length; i++) {
						for (let c = 1; c <= 3; c++) worst = Math.max(worst, Math.abs(+at[i][c] - +bt[i][c]));
					}
					return worst;
				};
				const midStep = differingGlyphs(frameAt(800), frameAt(800 + tick));
				const seamStep = differingGlyphs(frameAt(SWEEP_PERIOD_MS - tick), frameAt(SWEEP_PERIOD_MS));
				expect(seamStep).toBeLessThanOrEqual(midStep * 1.5 + 1);
			} finally {
				component.dispose();
			}
		});
	});

	it("sweeps a blue ramp, not neutral gray, on dark terminals", () => {
		const component = welcome();
		try {
			component.playIntro(() => {});
			// Each rendered row is `<border>│ …mark… <border>│`, so drop the first and
			// last colour escape on every row: those paint the border, not the mark.
			const markRows = component.render(120).slice(MARK_START, MARK_START + MARK_ROWS);
			const colours = markRows.flatMap(row =>
				[...row.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)]
					.slice(1, -1)
					.map(m => [Number(m[1]), Number(m[2]), Number(m[3])] as const),
			);
			if (colours.length === 0) {
				// No truecolor on this terminal (CI runners carry no terminal identity),
				// so the sweep degrades to the 256-colour ramp. The claim still holds
				// there: every index must come from the blue family and none from the
				// neutral gray ramp the old palette used.
				const blueRamp = new Set([17, 25, 111, 189]);
				const grayRamp = new Set([250, 252, 254, 231]);
				// Same border-stripping as the truecolor branch: the first and last
				// escape on each row paint the box edge, not the mark.
				const indices = markRows.flatMap(row =>
					[...row.matchAll(/\x1b\[38;5;(\d+)m/g)].slice(1, -1).map(m => Number(m[1])),
				);
				expect(indices.length).toBeGreaterThan(100);
				for (const index of indices) {
					expect(grayRamp.has(index)).toBe(false);
					expect(blueRamp.has(index)).toBe(true);
				}
				expect(new Set(indices).size).toBeGreaterThan(1);
				return;
			}
			expect(colours.length).toBeGreaterThan(100);

			// Every glyph is blue-dominant: the old #BCBEC0 ⇄ #FFFFFF ramp was
			// neutral, so r === g === b on every glyph it painted.
			for (const [r, g, b] of colours) {
				expect(b).toBeGreaterThan(r);
				expect(b).toBeGreaterThanOrEqual(g);
			}
			expect(colours.some(([r, g, b]) => r === g && g === b)).toBe(false);

			// And the ramp spans a wide value range, which is what makes the sweep
			// legible: the neutral ramp only ever covered luminance 121..255.
			const lum = ([r, g, b]: readonly number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
			const values = colours.map(lum);
			expect(Math.min(...values)).toBeLessThan(90);
			expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(140);
		} finally {
			component.dispose();
		}
	});

	it("renders the resting frame with no timer under reducedMotion", () => {
		const component = welcome({ reducedMotion: true });
		const { delays } = recordIntervals(() => {
			let renders = 0;
			component.playIntro(() => {
				renders += 1;
			});
			expect(renders).toBe(1);
		});

		expect(delays).toEqual([]);
		const first = component.render(120);
		component.dispose();
		expect(component.render(120)).toEqual(first);
		// Resting is still coloured art, not a bare monochrome mark.
		expect(stripRenderControls(first[MARK_START] ?? "")).toContain(MARK_TOP);
		expect(first[MARK_START]).toContain("\x1b[38;");
	});

	it("settles on the resting frame and clears the timer once the session is active", () => {
		const component = welcome({});
		const { delays, clears } = recordIntervals(() => {
			component.playIntro(() => {});
			// The component is never removed from the UI root, so an unsettled loop
			// would repaint the whole interface for the rest of the session.
			component.settle();
		});

		// The sweep armed one repeating timer, and settling cleared it.
		expect(delays).toHaveLength(1);
		expect(clears).toBe(1);
		const settled = component.render(120);
		expect(component.render(120)).toEqual(settled);
		expect(stripRenderControls(settled[MARK_START] ?? "")).toContain(MARK_TOP);
		component.dispose();
	});

	it("drops every panel and box the old two-column launch screen carried", () => {
		const lines = plain(
			new WelcomeComponent(
				"1.2.3",
				"qwen3-coder-30b",
				"vllm",
				[{ name: "tsserver", status: "ready", fileTypes: ["ts"] }],
				"unicode",
				{ cwd: CWD },
			),
			160,
		);
		const text = lines.join("\n");

		for (const removed of [
			"Vibrato Forge",
			"shape · act · prove",
			"What's New",
			"Flow keys",
			"Project pulse",
			"Session trail",
		]) {
			expect(text).not.toContain(removed);
		}
		// The border is back, but nothing divides the body: one column, no tees.
		expectClosedBox(lines, 160);
		for (const row of body(lines)) expect(row).not.toMatch(/[┬┴├┤┼]/);
		// LSP state stays one summary line; servers are never enumerated.
		expect(text).toContain("1 LSP server");
		expect(text).not.toContain("tsserver");
	});

	it("summarises LSP servers on one line", () => {
		const servers = Array.from({ length: 2 }, (_, index) => ({
			name: `server-${index}`,
			status: "ready" as const,
			fileTypes: ["ts"],
		}));
		const component = welcome();
		expect(plain(component, 80).join("\n")).toContain("No LSP servers");

		component.setLspServers(servers);
		expect(plain(component, 80).join("\n")).toContain("2 LSP servers");
	});

	it("renders the production build metadata label when no override is provided", () => {
		process.env.VIB_BUILD_CHANNEL = "release";
		const rendered = plain(welcome(), 120).join("\n");

		expect(rendered).toContain("1.2.3 · release build");
		expect(rendered).not.toContain("dev build");
	});

	it("keeps the four canonical key hints and honours remapped display context", () => {
		const rendered = plain(welcome({ keyDisplayContext: { platform: "linux" } }), 120).join("\n");

		expect(rendered).toContain("/  commands");
		expect(rendered).toContain("#  actions");
		expect(rendered).toContain("!  shell");
		expect(rendered).toContain("?  keymap");
		// The long flow-key rail is gone: no model/reasoning/newline entries.
		expect(rendered).not.toContain("reasoning");
		expect(rendered).not.toContain("newline");
	});

	it("updates the model row through setModel", () => {
		const component = welcome();
		component.setModel("claude-opus", "anthropic");

		expect(plain(component, 80).join("\n")).toContain("claude-opus · anthropic");
	});

	it("draws the square and ASCII marks when the logo mode asks for them", () => {
		const square = plain(new WelcomeComponent("1.2.3", "gpt-5.5", "openai", [], "square", { cwd: CWD }), 80).join(
			"\n",
		);
		expect(square).toContain("┌──┐        ┌──┐  ┌────┐  ┌───────┐");
		expect(square).toContain("└──────┘      └────┘  └───────┘");
		expect(square).not.toContain(MARK_TOP);

		const ascii = plain(new WelcomeComponent("1.2.3", "gpt-5.5", "openai", [], "ascii", { cwd: CWD }), 80).join("\n");
		expect(ascii).toContain("+--+        +--+  +----+  +-------+");
		expect(ascii).toContain("+----+       +----+  +-------+");
		expect(ascii).not.toContain(MARK_TOP);
		expect(ascii).not.toContain("┌──┐        ┌──┐");
	});
});

describe("welcome width behaviour", () => {
	it("draws a closed box of exactly the terminal width at any width", () => {
		for (const width of [4, 5, 12, 24, 40, 60, 80, 120, 200]) {
			expectClosedBox(plain(welcome(), width), width);
		}
	});

	it("returns nothing when there is no room to draw", () => {
		expect(welcome().render(3)).toEqual([]);
	});

	it("drops the mark whole rather than clipping it on a narrow terminal", () => {
		const fits = plain(welcome(), MARK_MIN_WIDTH);
		expect(fits).toHaveLength(FULL_TIER_ROWS);
		expect(fits[MARK_START]).toContain(MARK_TOP);

		const tooNarrow = plain(welcome(), MARK_MIN_WIDTH - 1);
		expect(tooNarrow).toHaveLength(MARKLESS_TIER_ROWS);
		expectClosedBox(tooNarrow, MARK_MIN_WIDTH - 1);
		// No partial mark and no clipped remnant of one: the only rounded corners
		// left are the border's own four.
		expect(body(tooNarrow).join("\n")).not.toMatch(/[╭╰╯╮]/);
		expect(body(tooNarrow)[1]).toStartWith("   Vibrato · LIG System");
	});

	it("reserves the composer gutter instead of drawing into it", () => {
		expectClosedBox(plain(welcome(), 80), 80);

		const gutter = plain(welcome({ rightGutterWidth: 3 }), 80);
		for (const line of gutter) {
			// The row still spans the terminal, but the box closes 3 columns early
			// and the gutter is blank all the way down.
			expect(visibleWidth(line)).toBe(80);
			expect(line.endsWith("   ")).toBe(true);
			expect(visibleWidth(line.trimEnd())).toBe(77);
		}
		expect(gutter.at(-1)?.trimEnd()).toBe(`╰${"─".repeat(75)}╯`);
	});

	it("drops right-aligned values rather than wrapping them", () => {
		const narrow = plain(welcome(), 30);

		expectClosedBox(narrow, 30);
		// No room for the workspace beside the model, so it is dropped whole.
		expect(narrow.join("\n")).not.toContain("gajae-code");
		expect(narrow.join("\n")).toContain("qwen3-coder-30b");
	});

	it("elides a long workspace path in the middle", () => {
		const long = plain(
			welcome({ cwd: path.join(os.homedir(), "very/deeply/nested/workspace/directory/target-project") }),
			60,
		).join("\n");

		expect(long).toContain("~/…/target-project");
	});

	it("sheds key hints from the right before overflowing", () => {
		const hints = plain(welcome({ keyDisplayContext: { platform: "linux" } }), 26).join("\n");

		expect(hints).toContain("/  commands");
		expect(hints).not.toContain("?  keymap");
	});
});

describe("welcome viewport row budget", () => {
	const sized = (rows: number, reserved: number) =>
		welcome({ getViewportRows: () => rows, getReservedBottomRows: () => reserved });

	it("renders the full mark tier when the viewport allows it", () => {
		const lines = plain(sized(FULL_TIER_ROWS + 6, 6), 100);

		expect(lines).toHaveLength(FULL_TIER_ROWS);
		expectClosedBox(lines, 100);
		const rows = body(lines);
		expect(rows[1]).toContain(MARK_TOP);
		expect(rows[MARK_ROWS + 1]?.trim()).toBe("");
		expect(rows[MARK_ROWS + 2]).toContain("Vibrato · LIG System");
		expect(rows[MARK_ROWS + 4]).toContain("qwen3-coder-30b · vllm");
		expect(rows[MARK_ROWS + 5]).toContain("No LSP servers");
		expect(rows[MARK_ROWS + 7]).toContain("/  commands");
	});

	it("never pads past its natural height on a roomy viewport", () => {
		expect(plain(sized(60, 2), 100)).toHaveLength(FULL_TIER_ROWS);
		expect(plain(welcome(), 100)).toHaveLength(FULL_TIER_ROWS);
	});

	it("drops the mark rather than the information when the budget cannot hold both", () => {
		// One row short of the full tier: the mark goes, the information stays.
		const lines = plain(
			welcome({
				getViewportRows: () => FULL_TIER_ROWS - 1 + 2,
				getReservedBottomRows: () => 2,
				buildLabel: "release build",
			}),
			100,
		);

		expect(lines).toHaveLength(MARKLESS_TIER_ROWS);
		expectClosedBox(lines, 100);
		// The version keeps its place on the rail; only the mark is given up.
		expect(lines[0]).toStartWith("╭─── vib v1.2.3 · release build ───");
		const rows = body(lines);
		expect(rows.join("\n")).not.toMatch(/[╭╰╯╮]/);
		expect(rows[0]?.trim()).toBe("");
		expect(rows[1]).toStartWith("   Vibrato · LIG System");
		expect(rows[2]?.trim()).toBe("");
		expect(rows[3]).toContain("qwen3-coder-30b · vllm");
		expect(rows[4]).toContain("No LSP servers");
		expect(rows[5]?.trim()).toBe("");
		expect(rows[6]).toContain("/  commands");
		expect(rows[7]?.trim()).toBe("");
	});

	it("degrades tier by tier as the row budget shrinks", () => {
		// Each budget spends two rows on the border and the rest on content.
		for (const [budget, rows] of [
			[10, MARKLESS_TIER_ROWS],
			[9, 8],
			[8, 8],
			[7, 7],
			[6, 6],
			[5, 5],
		] as const) {
			const lines = plain(sized(budget + 2, 2), 100);
			expect(lines).toHaveLength(rows);
			expectClosedBox(lines, 100);
		}
	});

	it("falls back to a box holding just the identity and model rows", () => {
		const lines = plain(sized(6, 2), 100);

		expect(lines).toHaveLength(4);
		expectClosedBox(lines, 100);
		const rows = body(lines);
		expect(rows[0]).toStartWith("   Vibrato · LIG System");
		expect(rows[1]).toContain("qwen3-coder-30b · vllm");
	});

	it("falls back to a box holding the identity row alone", () => {
		const lines = plain(sized(5, 2), 100);

		expect(lines).toHaveLength(3);
		expectClosedBox(lines, 100);
		expect(body(lines)[0]).toStartWith("   Vibrato · LIG System");
	});

	it("closes the border even when only the rail and one edge fit", () => {
		const two = plain(
			welcome({ getViewportRows: () => 4, getReservedBottomRows: () => 2, buildLabel: "release build" }),
			100,
		);
		expect(two).toHaveLength(2);
		expect(two[0]).toStartWith("╭─── vib v1.2.3 · release build ───");
		expect(two[1]).toBe(`╰${"─".repeat(98)}╯`);

		// A single row leaves only the rail, which still carries name and version.
		const one = plain(
			welcome({ getViewportRows: () => 3, getReservedBottomRows: () => 2, buildLabel: "release build" }),
			100,
		);
		expect(one).toHaveLength(1);
		expect(one[0]).toStartWith("╭─── vib v1.2.3 · release build ───");
		expect(one[0]).toEndWith("╮");
		expect(visibleWidth(one[0] ?? "")).toBe(100);
	});

	it("yields the surface entirely when the pinned composer fills the viewport", () => {
		expect(sized(5, 5).render(80)).toEqual([]);
	});
});
