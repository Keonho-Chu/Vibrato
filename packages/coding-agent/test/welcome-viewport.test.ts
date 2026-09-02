import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@vib-rato/tui";
import { WelcomeComponent } from "../src/modes/components/welcome";
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
	const theme = await getThemeByName("red-claw");
	if (!theme) throw new Error("Failed to load red-claw theme");
	setThemeInstance(theme);
});

/** Brand rule glyph (U+258C) that opens the wordmark and identity rows. */
const BRAND_RULE = "▌";
// `shortenPath` abbreviates against the real home directory, so anchor there.
const CWD = path.join(os.homedir(), "Documents", "GitHub", "LGJ", "gajae-code");

function stripRenderControls(line: string): string {
	return stripVTControlCharacters(line);
}

function welcome(options: ConstructorParameters<typeof WelcomeComponent>[4] = {}): WelcomeComponent {
	return new WelcomeComponent("1.2.3", "qwen3-coder-30b", "vllm", [], { cwd: CWD, ...options });
}

function plain(component: WelcomeComponent, width: number): string[] {
	return component.render(width).map(stripRenderControls);
}

describe("welcome launch surface", () => {
	it("renders the brand rule, a plain-text wordmark, the version, model and workspace", () => {
		const lines = plain(welcome({ buildLabel: "release build" }), 80);

		expect(lines[0]).toStartWith(`${BRAND_RULE} vib`);
		expect(lines[0]).toEndWith("1.2.3 · release build");
		expect(lines[1]).toBe(`${BRAND_RULE} Vibrato · LIG System`);

		const text = lines.join("\n");
		expect(text).toContain("qwen3-coder-30b · vllm");
		expect(text).toContain("~/Documents/GitHub/LGJ/gajae-code");
		expect(text).toContain("No LSP servers");
	});

	it("draws no block-letter mark and emits no gradient sweep escapes", () => {
		const component = welcome();
		let renders = 0;
		component.playIntro(() => {
			renders += 1;
		});

		// A single settling render, and no interval left behind to drive more.
		expect(renders).toBe(1);
		const first = component.render(120);
		component.dispose();
		expect(component.render(120)).toEqual(first);

		const raw = first.join("\n");
		// The sweep coloured the mark one glyph at a time, so an escape landed
		// between every pair of letters. The wordmark must now be one plain run.
		expect(first[0]).toContain("vib");
		// And the whole surface stays in single-digit escapes per row rather than
		// the hundreds a per-character gradient over block art emitted.
		expect(raw.match(/\x1b\[/g)?.length ?? 0).toBeLessThanOrEqual(64);
		// Block-letter art and box chrome are gone for good.
		expect(stripRenderControls(raw)).not.toMatch(/[╭╰╯╮┌┐└┘│]/);
	});

	it("drops every panel the old two-column launch screen carried", () => {
		const text = plain(
			new WelcomeComponent(
				"1.2.3",
				"qwen3-coder-30b",
				"vllm",
				[{ name: "tsserver", status: "ready", fileTypes: ["ts"] }],
				{
					cwd: CWD,
				},
			),
			160,
		).join("\n");

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
});

describe("welcome width behaviour", () => {
	it("never exceeds the terminal width at any width", () => {
		for (const width of [4, 5, 12, 24, 40, 60, 80, 120, 200]) {
			for (const line of plain(welcome(), width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("returns nothing when there is no room to draw", () => {
		expect(welcome().render(3)).toEqual([]);
	});

	it("reserves the composer gutter instead of drawing into it", () => {
		const gutterless = plain(welcome(), 80);
		const gutter = plain(welcome({ rightGutterWidth: 3 }), 80);

		for (const line of gutter) expect(visibleWidth(line)).toBeLessThanOrEqual(77);
		// The right-aligned version moves left by exactly the reserved gutter.
		expect(visibleWidth(gutterless[0] ?? "")).toBe(80);
		expect(visibleWidth(gutter[0] ?? "")).toBe(77);
	});

	it("drops right-aligned values rather than wrapping them", () => {
		const narrow = plain(welcome(), 30);

		for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
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

	it("renders the full seven-row surface when the viewport allows it", () => {
		const lines = plain(sized(24, 6), 100);

		expect(lines).toHaveLength(7);
		expect(lines[2]).toBe("");
		expect(lines[5]).toBe("");
		expect(lines[6]).toContain("/  commands");
	});

	it("never pads past its natural height on a roomy viewport", () => {
		expect(plain(sized(60, 2), 100)).toHaveLength(7);
		expect(plain(welcome(), 100)).toHaveLength(7);
	});

	it("degrades tier by tier as the row budget shrinks", () => {
		expect(plain(sized(8, 2), 100)).toHaveLength(6);
		expect(plain(sized(7, 2), 100)).toHaveLength(5);
		expect(plain(sized(6, 2), 100)).toHaveLength(4);
		expect(plain(sized(5, 2), 100)).toHaveLength(3);
	});

	it("falls back to a two-line tier of brand rule plus model", () => {
		const lines = plain(sized(4, 2), 100);

		expect(lines).toHaveLength(2);
		expect(lines[0]).toStartWith(`${BRAND_RULE} vib`);
		expect(lines[1]).toContain("qwen3-coder-30b · vllm");
	});

	it("falls back to a one-line tier of the brand rule alone", () => {
		const lines = plain(
			welcome({ getViewportRows: () => 3, getReservedBottomRows: () => 2, buildLabel: "release build" }),
			100,
		);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toStartWith(`${BRAND_RULE} vib`);
		expect(lines[0]).toEndWith("1.2.3 · release build");
	});

	it("yields the surface entirely when the pinned composer fills the viewport", () => {
		expect(sized(5, 5).render(80)).toEqual([]);
	});
});
