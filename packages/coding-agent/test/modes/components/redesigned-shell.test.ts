import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@vib-rato/ai";
import { resetSettingsForTest, Settings } from "@vib-rato/coding-agent/config/settings";
import { AssistantMessageComponent } from "@vib-rato/coding-agent/modes/components/assistant-message";
import { BashExecutionComponent } from "@vib-rato/coding-agent/modes/components/bash-execution";
import { CustomEditor } from "@vib-rato/coding-agent/modes/components/custom-editor";
import { EvalExecutionComponent } from "@vib-rato/coding-agent/modes/components/eval-execution";
import { FooterComponent } from "@vib-rato/coding-agent/modes/components/footer";
import { STATUS_LINE_PRESETS } from "@vib-rato/coding-agent/modes/components/status-line/presets";
import { UserMessageComponent } from "@vib-rato/coding-agent/modes/components/user-message";
import { WelcomeComponent } from "@vib-rato/coding-agent/modes/components/welcome";
import { getEditorTheme, initTheme } from "@vib-rato/coding-agent/modes/theme/theme";
import type { AgentSession } from "@vib-rato/coding-agent/session/agent-session";
import { type TUI, visibleWidth } from "@vib-rato/tui";
import { StatusLineComponent } from "../../../src/modes/components/tool-status-header";

interface FooterUsageStatistics {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly premiumRequests: number;
	readonly cost: number;
}

const DEFAULT_FOOTER_USAGE: FooterUsageStatistics = {
	input: 1234,
	output: 567,
	cacheRead: 89,
	cacheWrite: 12,
	premiumRequests: 0,
	cost: 0.123,
};

function createFooterSession(
	usageStatistics: FooterUsageStatistics = DEFAULT_FOOTER_USAGE,
	getEntries: () => readonly unknown[] = () => [
		{
			type: "message",
			message: {
				role: "assistant",
				usage: {
					input: 1234,
					output: 567,
					cacheRead: 89,
					cacheWrite: 12,
					cost: { total: 0.123 },
					premiumRequests: 0,
				},
			},
		},
	],
): AgentSession {
	return {
		state: {
			messages: [],
			model: { id: "very-long-model-name-for-footer-budget", contextWindow: 200_000 },
		},
		sessionManager: {
			getSessionName: () => "forge-session",
			getSessionId: () => "session-123456",
			getUsageStatistics: () => usageStatistics,
			getEntries,
		},
		getContextUsage: () => ({
			tokens: 85_000,
			contextWindow: 200_000,
			percent: 42.5,
			source: "provider_anchor" as const,
		}),
		getGoalModeState: () => undefined,
		getAsyncJobSnapshot: () => ({ running: [] }),
		isFastModeActive: () => false,
		modelRegistry: { isUsingOAuth: () => false },
	} as unknown as AgentSession;
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

describe("redesigned interactive shell chrome", () => {
	it("renders opencode-style minimal user and vibrato turns", () => {
		const user = Bun.stripANSI(new UserMessageComponent("hello").render(80).join("\n"));
		const assistant = Bun.stripANSI(
			new AssistantMessageComponent(createAssistantMessage("hi")).render(80).join("\n"),
		);

		expect(user).toContain("user");
		expect(assistant).toContain("vibrato");
		expect(user).not.toContain("operator input");
		expect(assistant).not.toContain("assistant");
		expect(assistant).not.toContain("vibrato reply");
		expect(user).not.toContain("▸");
		expect(assistant).not.toContain("▌");
	});

	it("sizes submitted Korean user prompts to the current viewport width", () => {
		const prompt = "안녕하세요 ".repeat(30);
		const narrowLines = new UserMessageComponent(prompt).render(80);
		const wideLines = new UserMessageComponent(prompt).render(160);
		const contentWidths = (lines: string[]) =>
			lines
				.map(line =>
					Bun.stripANSI(line)
						.replace(/\x1b\]133;[ABC]\x07/g, "")
						.trimEnd(),
				)
				.filter(line => line.includes("안녕하세요"))
				.map(line => visibleWidth(line));

		const narrowContentWidths = contentWidths(narrowLines);
		const wideContentWidths = contentWidths(wideLines);

		expect(wideContentWidths.length).toBeLessThan(narrowContentWidths.length);
		expect(Math.max(...wideContentWidths)).toBeGreaterThan(120);
		for (const line of narrowLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
		for (const line of wideLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(160);
		}
	});

	it("keeps the minimal launch surface responsive", () => {
		const component = new WelcomeComponent("1.2.3", "gpt-5.5", "openai");
		const lines = component.render(54);
		const rendered = Bun.stripANSI(lines.join("\n"));

		expect(rendered).toContain("▌ vib");
		expect(rendered).toContain("▌ Vibrato · LIG System");
		// No block-letter mark, and no box chrome around it.
		expect(rendered).not.toContain("╭──╮        ╭──╮  ╭────╮  ╭───────╮");
		expect(rendered).not.toMatch(/[╭╰╯╮│]/);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(54);
		}
	});

	it("right-aligns the version to the terminal edge on wide terminals", () => {
		const component = new WelcomeComponent("1.2.3", "gpt-5.5", "openai");
		const narrowTop = Bun.stripANSI(component.render(100)[0] ?? "");
		const wideLines = component.render(160);
		const wideTop = Bun.stripANSI(wideLines[0] ?? "");

		expect(visibleWidth(narrowTop)).toBe(100);
		expect(visibleWidth(wideTop)).toBe(160);
		expect(wideTop).toStartWith("▌ vib");
		expect(wideTop).toContain("1.2.3");
		for (const line of wideLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(160);
		}
	});

	it("renders the live composer as a borderless opencode-style prompt", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setBorderVisible(false);
		editor.setPromptGutter("› ");
		editor.setPaddingX(1);
		editor.setText("draft");

		const rendered = Bun.stripANSI(editor.render(40).join("\n"));

		expect(rendered).toContain("› draft");
		expect(rendered).not.toContain("╭");
		expect(rendered).not.toContain("╰");
	});

	it("renders the main status rail outside the borderless composer", () => {
		const statusLine = new StatusLineComponent(createFooterSession());
		const editor = new CustomEditor(getEditorTheme());
		editor.setBorderVisible(false);
		editor.setPromptGutter("› ");
		editor.setPaddingX(1);
		editor.setText("draft");

		const statusRendered = Bun.stripANSI(statusLine.render(140).join("\n"));
		const editorRendered = Bun.stripANSI(editor.render(140).join("\n"));

		expect(statusRendered).toContain("very-long-model-name-for-footer-budget");
		expect(statusRendered).toContain("forge-session");
		expect(statusRendered).toMatch(/very-long-model-name-for-footer-budget[^\n]*\d+(\.\d+)?%/);
		expect(editorRendered).toContain("› draft");
		expect(editorRendered).not.toContain("very-long-model-name-for-footer-budget");
		expect(editorRendered).not.toContain("╭");
	});

	it("renders execution rails without breaking output caps", () => {
		const ui = { requestRender: () => {} } as unknown as TUI;
		const bash = new BashExecutionComponent("printf ready", ui, false);
		bash.setComplete(0, false, { output: Array.from({ length: 160 }, (_, i) => `line-${i}`).join("\n") });
		const bashRendered = Bun.stripANSI(bash.render(80).join("\n"));

		expect(bashRendered).toContain("shell · $ printf");
		expect(bashRendered).toContain("ctrl+o to expand");
		expect(bashRendered).not.toContain("line-0\n");
		for (const line of bash.render(80)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
	});

	it("keeps eval execution headers compact and mode-labeled", () => {
		const ui = { requestRender: () => {} } as unknown as TUI;
		const py = new EvalExecutionComponent("print('ready')", ui, false, "python");
		const js = new EvalExecutionComponent("1 + 1", ui, false, "js");

		expect(Bun.stripANSI(py.render(80).join("\n"))).toContain("python · >>>");
		expect(Bun.stripANSI(js.render(80).join("\n"))).toContain("node · >>>");
	});

	it("keeps eval continuation aligned for multiline code", () => {
		const ui = { requestRender: () => {} } as unknown as TUI;
		const py = new EvalExecutionComponent("print('a')\nprint('b')", ui, false, "python");
		const stripped = Bun.stripANSI(py.render(80).join("\n"));

		expect(stripped).toContain("python · >>> print('a')");
		expect(stripped).toContain("          print('b')");
	});

	it("keeps OSC 133 prompt markers scoped to the message body", () => {
		const rendered = new UserMessageComponent("hello").render(80);

		expect(rendered[0]).not.toContain("\x1b]133;A\x07");
		expect(rendered[1]).not.toContain("\x1b]133;A\x07");
		expect(rendered[2]).toContain("\x1b]133;A\x07");
		expect(rendered[rendered.length - 1]).toContain("\x1b]133;B\x07\x1b]133;C\x07");
	});

	it("budgets footer prefixes before truncating pulse", () => {
		const footer = new FooterComponent(createFooterSession());
		const lines = footer.render(72);
		const rendered = Bun.stripANSI(lines.join("\n"));

		expect(rendered).toContain("cwd");
		expect(rendered).toContain("pulse");
		expect(rendered).toContain("very-long-mod");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(72);
		}
	});

	it("renders cumulative parent and task usage in the legacy footer exactly once", () => {
		const footer = new FooterComponent(
			createFooterSession({
				input: 4000,
				output: 6000,
				cacheRead: 8000,
				cacheWrite: 10_000,
				premiumRequests: 3,
				cost: 4,
			}),
		);
		const rendered = Bun.stripANSI(footer.render(160).join("\n"));

		expect(rendered).toContain("↑4K ↓6K R8K W10K");
		expect(rendered).toContain("$4.000 ★ 3");
		expect(rendered.match(/\$4\.000/g)).toHaveLength(1);
	});

	it("uses the session usage aggregate without rescanning legacy task entries", () => {
		const footer = new FooterComponent(
			createFooterSession(DEFAULT_FOOTER_USAGE, () => {
				throw new Error("Footer must not rescan persisted entries");
			}),
		);
		const rendered = Bun.stripANSI(footer.render(160).join("\n"));

		expect(rendered).toContain("↑1.2K ↓567 R89 W12 $0.123");
	});

	it("keeps public status presets on the Vibrato identity", () => {
		for (const [name, preset] of Object.entries(STATUS_LINE_PRESETS)) {
			expect(preset.leftSegments, name).not.toContain("pi");
		}

		expect(STATUS_LINE_PRESETS.full.leftSegments).toContain("vibrato");
		expect(STATUS_LINE_PRESETS.nerd.leftSegments).toContain("vibrato");
	});

	it("keeps the default status preset dense and pulse-forward", () => {
		expect(STATUS_LINE_PRESETS.default.leftSegments).toEqual(["model", "mode", "git", "pr", "path"]);
		expect(STATUS_LINE_PRESETS.default.rightSegments).toEqual(["session_name", "jobs", "token_rate", "cost"]);
		expect(STATUS_LINE_PRESETS.default.segmentOptions?.path?.maxLength).toBe(32);
	});

	it("adds a default plus usage status preset without changing default", () => {
		expect(STATUS_LINE_PRESETS["default-usage"].leftSegments).toEqual(STATUS_LINE_PRESETS.default.leftSegments);
		expect(STATUS_LINE_PRESETS["default-usage"].rightSegments).toEqual([
			"session_name",
			"jobs",
			"token_rate",
			"usage",
			"cost",
		]);
		expect(STATUS_LINE_PRESETS["default-usage"].segmentOptions).toEqual(STATUS_LINE_PRESETS.default.segmentOptions);
	});

	it("keeps launch rendering on the bounded-work path", () => {
		const component = new WelcomeComponent("1.2.3", "gpt-5.5", "openai", [
			{ name: "very-long-server-name".repeat(10), status: "ready", fileTypes: ["ts"] },
		]);
		const first = component.render(96);
		const second = component.render(96);

		expect(first).toHaveLength(second.length);
		expect(first.join("\n")).toBe(second.join("\n"));
		for (const line of first) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(96);
		}
	});
});
