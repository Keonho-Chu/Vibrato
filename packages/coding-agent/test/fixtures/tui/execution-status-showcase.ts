import { Agent } from "@vib-rato/agent-core";
import { Text } from "@vib-rato/tui";
import { TempDir } from "@vib-rato/utils";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";
import { ModelRegistry } from "../../../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../../../src/config/settings";
import type { ExecutionStatusSnapshot } from "../../../src/modes/execution-status";
import { InteractiveMode } from "../../../src/modes/interactive-mode";
import { initTheme } from "../../../src/modes/theme/theme";
import { AgentSession } from "../../../src/session/agent-session";
import { AuthStorage } from "../../../src/session/auth-storage";
import { SessionManager } from "../../../src/session/session-manager";

export const EXECUTION_SHOWCASE_STATES = [
	"idle",
	"model",
	"response",
	"tool",
	"parallel-tools",
	"tool-failure",
	"retry",
	"compaction",
	"input",
	"background",
	"queued",
	"long-cjk",
] as const;
export type ExecutionShowcaseState = (typeof EXECUTION_SHOWCASE_STATES)[number];
export const EXECUTION_SHOWCASE_VIEWPORTS = [
	{ columns: 80, rows: 24 },
	{ columns: 120, rows: 36 },
	{ columns: 160, rows: 48 },
	{ columns: 48, rows: 16 },
] as const;

export function executionShowcaseSnapshot(state: ExecutionShowcaseState): ExecutionStatusSnapshot {
	const snapshot: ExecutionStatusSnapshot = {
		phase: "model",
		elapsedMs: 42_000,
		runningTools: 0,
		completedTools: 2,
		failedTools: 0,
		backgroundTasks: 0,
		queuedMessages: 0,
		inputRequests: 0,
	};
	switch (state) {
		case "idle":
			return { ...snapshot, phase: "idle", completedTools: 0 };
		case "model":
			return snapshot;
		case "response":
			return { ...snapshot, phase: "response" };
		case "tool":
			return { ...snapshot, phase: "tools", runningTools: 1, toolName: "bash", intent: "Running focused tests" };
		case "parallel-tools":
			return {
				...snapshot,
				phase: "tools",
				runningTools: 3,
				backgroundTasks: 2,
				queuedMessages: 1,
				toolName: "read",
				intent: "Inspecting execution handlers",
			};
		case "tool-failure":
			return {
				...snapshot,
				phase: "tools",
				runningTools: 1,
				failedTools: 1,
				toolName: "bash",
				intent: "Checking the failed assertion",
			};
		case "retry":
			return {
				...snapshot,
				phase: "retry",
				retryAttempt: 2,
				retryMaxAttempts: 4,
				retryInMs: 12_000,
				retryReason: "rate limited",
			};
		case "compaction":
			return { ...snapshot, phase: "compaction" };
		case "input":
			return { ...snapshot, phase: "input", inputRequests: 1, runningTools: 1, backgroundTasks: 2 };
		case "background":
			return { ...snapshot, phase: "background", backgroundTasks: 2 };
		case "queued":
			return { ...snapshot, phase: "queued", queuedMessages: 2 };
		case "long-cjk":
			return {
				...snapshot,
				phase: "tools",
				runningTools: 2,
				toolName: "read",
				intent: "실행 상태 확인 · 入力待ちの確認 · 检查运行状态 · Inspecting the integration boundary ".repeat(4),
			};
	}
}

export interface ExecutionShowcaseFrame {
	position: "bottom" | "middle" | "top";
	terminalAnsi: string;
	terminalText: string;
	summaryRows: string[];
	focusedComposer: boolean;
	pinnedStatus: boolean;
}

/** Full production root with deterministic presentation snapshots, not a live provider. */
export async function renderExecutionShowcase(
	state: ExecutionShowcaseState,
	viewport: { columns: number; rows: number },
): Promise<ExecutionShowcaseFrame[]> {
	const dir = TempDir.createSync("@execution-showcase-");
	resetSettingsForTest();
	await initTheme(false, "unicode", false, "lig-blue", "lig-blue");
	await Settings.init({
		inMemory: true,
		cwd: dir.path(),
		overrides: {
			"startup.quiet": true,
			"startup.skipLogoAnimation": true,
			"statusLine.preset": "custom",
			"statusLine.leftSegments": ["model"],
			"statusLine.rightSegments": [],
			"statusLine.showSkillHud": false,
			"statusLine.watchGitHead": false,
			"pet.mode": "off",
		},
	});
	const auth = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(auth);
	const model = registry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Execution showcase model is unavailable");
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] } }),
		agentId: "execution-showcase",
		sessionManager: SessionManager.create(dir.path(), dir.path()),
		settings: Settings.isolated(),
		modelRegistry: registry,
	});
	const mode = new InteractiveMode(session, "execution-showcase");
	const terminal = new VirtualTerminal(viewport.columns, viewport.rows, { isProcessTerminal: true });
	(mode.ui as unknown as { terminal: VirtualTerminal }).terminal = terminal;
	// The fixture fixes presentation state only. Controller lifecycle tests exercise real events separately.
	const snapshot = executionShowcaseSnapshot(state);
	mode.executionStatus.getSnapshot = () => snapshot;
	try {
		await mode.init();
		for (let index = 0; index < 100; index++) {
			mode.chatContainer.addChild(
				new Text(`Transcript ${index + 1}: reviewing execution state without losing the composer`, 0, 0),
			);
		}
		mode.recordVisibleTranscriptMutation();
		mode.editor.setText("계속 진행 · Continue reviewing");
		mode.editor.setUseTerminalCursor(true);
		mode.ui.setFocus(mode.editor);
		const frames: ExecutionShowcaseFrame[] = [];
		for (const position of ["bottom", "middle", "top"] as const) {
			if (position === "middle") mode.ui.scrollViewportBy(-40, { pin: "stable" });
			if (position === "top") mode.ui.scrollViewportBy(-1000, { pin: "stable" });
			mode.ui.requestRender(true);
			await terminal.waitForRender();
			const terminalAnsi = terminal.getViewportAnsi();
			frames.push({
				position,
				terminalAnsi,
				terminalText: Bun.stripANSI(terminalAnsi),
				summaryRows: mode.statusLine.render(viewport.columns).map(row => Bun.stripANSI(row)),
				focusedComposer: mode.ui.getFocusedComponent() === mode.editor,
				pinnedStatus: mode.ui.getViewportObservation()?.pinBoundary.pinned === true,
			});
		}
		return frames;
	} finally {
		mode.stop();
		await session.dispose();
		auth.close();
		await dir.remove();
		resetSettingsForTest();
	}
}
