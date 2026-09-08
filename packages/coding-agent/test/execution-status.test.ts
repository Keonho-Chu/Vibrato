import { beforeAll, describe, expect, it, vi } from "bun:test";
import { renderExecutionStatus } from "../src/modes/components/execution-status";
import { ExecutionStatusTracker } from "../src/modes/execution-status";
import { initTheme } from "../src/modes/theme/theme";
import type { AgentSessionEvent } from "../src/session/agent-session";
import { createAssistantMessage } from "./helpers/agent-session-setup";

type ToolStart = Extract<AgentSessionEvent, { type: "tool_execution_start" }>;
type ToolEnd = Extract<AgentSessionEvent, { type: "tool_execution_end" }>;
const toolStart = (id: string, name = "read", intent?: string): ToolStart => ({
	type: "tool_execution_start",
	toolCallId: id,
	toolName: name,
	args: {},
	intent,
});
const toolEnd = (id: string, details?: unknown, isError = false): ToolEnd => ({
	type: "tool_execution_end",
	toolCallId: id,
	toolName: "read",
	result: { content: [], details },
	isError,
});
function response(text: string): AgentSessionEvent {
	const message = createAssistantMessage(text);
	return {
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: message },
	};
}
const retry = (delayMs: number, attempt = 1): AgentSessionEvent => ({
	type: "auto_retry_start",
	attempt,
	maxAttempts: 3,
	delayMs,
	errorMessage: "connection timeout; private provider details",
});

beforeAll(async () => {
	await initTheme();
});

describe("execution state projection", () => {
	it("measures observed phases from a zero clock and ignores empty response placeholders", () => {
		let now = 0;
		const tracker = new ExecutionStatusTracker(undefined, () => now);
		tracker.start();
		now = 1500;
		tracker.handleEvent({ type: "message_start", message: createAssistantMessage("") });
		tracker.handleEvent(response(""));
		expect(tracker.getSnapshot()).toMatchObject({ phase: "model", elapsedMs: 1500 });
		tracker.handleEvent(response("answer"));
		expect(tracker.getSnapshot()).toMatchObject({ phase: "response", elapsedMs: 0 });
		now = 2200;
		expect(tracker.getSnapshot().elapsedMs).toBe(700);
		tracker.handleEvent({ type: "message_end", message: createAssistantMessage("answer") });
		expect(tracker.getSnapshot()).toMatchObject({ phase: "model", elapsedMs: 0 });
	});
	it("does not schedule summary changes for every streamed token", () => {
		const change = vi.fn();
		const tracker = new ExecutionStatusTracker(change);
		tracker.start();
		tracker.handleEvent(response("a"));
		const calls = change.mock.calls.length;
		tracker.handleEvent(response("ab"));
		expect(change.mock.calls.length).toBe(calls);
	});
	it("recognizes populated nonstreaming assistant starts without treating empty starts as responses", () => {
		const tracker = new ExecutionStatusTracker();
		tracker.start();
		tracker.handleEvent({ type: "message_start", message: createAssistantMessage("") });
		expect(tracker.getSnapshot().phase).toBe("model");
		tracker.handleEvent({
			type: "message_start",
			message: createAssistantMessage("Completed nonstreaming response"),
		});
		expect(tracker.getSnapshot().phase).toBe("response");
	});
	it("counts concurrent execution once and resets counters on a new prompt", () => {
		const tracker = new ExecutionStatusTracker();
		tracker.handleEvent({ type: "agent_start" });
		tracker.handleEvent(toolStart("a"));
		tracker.handleEvent(toolStart("a"));
		tracker.handleEvent(toolStart("b"));
		expect(tracker.getSnapshot().runningTools).toBe(2);
		tracker.handleEvent(toolEnd("a"));
		tracker.handleEvent(toolEnd("a"));
		tracker.handleEvent(toolEnd("unknown", undefined, true));
		tracker.handleEvent(toolEnd("b", undefined, true));
		expect(tracker.getSnapshot()).toMatchObject({
			runningTools: 0,
			completedTools: 1,
			failedTools: 1,
			phase: "model",
		});
		tracker.handleEvent({ type: "agent_start" });
		expect(tracker.getSnapshot()).toMatchObject({ completedTools: 0, failedTools: 0, phase: "model" });
	});
	it("takes background handoff from result metadata, never names or prose", () => {
		const tracker = new ExecutionStatusTracker();
		tracker.handleEvent(toolStart("a", "background_runner", "Spawning an async background task"));
		expect(tracker.getSnapshot()).toMatchObject({ phase: "tools", runningTools: 1, backgroundTasks: 0 });
		tracker.handleEvent(toolEnd("a", { async: { state: "running" } }));
		expect(tracker.getSnapshot()).toMatchObject({
			runningTools: 0,
			completedTools: 0,
			toolName: undefined,
			intent: undefined,
		});
		tracker.handleEvent({ type: "agent_end", messages: [] });
		expect(tracker.getSnapshot({ backgroundTasks: 2, queuedMessages: 1 })).toMatchObject({
			phase: "background",
			backgroundTasks: 2,
			queuedMessages: 1,
		});
	});
	it("uses a deadline for retry backoff and never exposes provider error details", () => {
		let now = 100;
		const tracker = new ExecutionStatusTracker(undefined, () => now);
		tracker.start();
		tracker.handleEvent(retry(1000));
		now += 400;
		expect(tracker.getSnapshot()).toMatchObject({ phase: "retry", retryInMs: 600, retryReason: "connection error" });
		tracker.handleEvent(retry(2000, 2));
		expect(tracker.getSnapshot()).toMatchObject({ retryInMs: 2000, elapsedMs: 0 });
		now += 2500;
		expect(tracker.getSnapshot().retryInMs).toBe(0);
		tracker.handleEvent({ type: "agent_start" });
		expect(tracker.getSnapshot()).toMatchObject({ phase: "model", retryInMs: undefined });
		tracker.handleEvent(retry(100));
		tracker.stop();
		expect(tracker.getSnapshot().phase).toBe("retry");
		tracker.handleEvent({ type: "auto_retry_end", success: false, attempt: 1 });
		expect(tracker.getSnapshot().phase).toBe("idle");
		tracker.handleEvent({ type: "auto_retry_end", success: true, attempt: 1 });
		expect(tracker.getSnapshot().phase).toBe("idle");
	});
	it("preserves maintenance across foreground stop without inventing retry", () => {
		const tracker = new ExecutionStatusTracker();
		tracker.start();
		tracker.handleEvent({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
		tracker.stop();
		expect(tracker.getSnapshot().phase).toBe("compaction");
		tracker.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: true,
		});
		expect(tracker.getSnapshot().phase).toBe("model");
		tracker.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: false,
		});
		expect(tracker.getSnapshot().phase).toBe("idle");
	});
	it("releases manual maintenance independently from input and reset generations", () => {
		const tracker = new ExecutionStatusTracker();
		const finish = tracker.beginMaintenance();
		const input = tracker.beginInput();
		expect(tracker.getSnapshot().phase).toBe("input");
		input();
		expect(tracker.getSnapshot().phase).toBe("compaction");
		tracker.reset();
		const fresh = tracker.beginMaintenance();
		finish();
		expect(tracker.getSnapshot().phase).toBe("compaction");
		fresh();
		expect(tracker.getSnapshot().phase).toBe("idle");
	});
	it("restores the current underlying state when concurrent input leases close", () => {
		const tracker = new ExecutionStatusTracker();
		tracker.start();
		tracker.handleEvent(toolStart("a"));
		const first = tracker.beginInput();
		const second = tracker.beginInput();
		tracker.handleEvent(toolEnd("a"));
		first();
		first();
		expect(tracker.getSnapshot()).toMatchObject({ phase: "input", inputRequests: 1 });
		second();
		expect(tracker.getSnapshot()).toMatchObject({ phase: "model", runningTools: 0 });
		const third = tracker.beginInput();
		tracker.handleEvent({ type: "agent_end", messages: [] });
		third();
		expect(tracker.getSnapshot().phase).toBe("idle");
	});
	it("does not let revoked input or late tool completions mutate a replacement run", () => {
		const tracker = new ExecutionStatusTracker();
		tracker.handleEvent(toolStart("old"));
		const old = tracker.beginInput();
		tracker.reset();
		const fresh = tracker.beginInput();
		old();
		tracker.handleEvent(toolEnd("old"));
		expect(tracker.getSnapshot()).toMatchObject({ inputRequests: 1, completedTools: 0 });
		fresh();
		tracker.handleEvent(toolStart("new"));
		tracker.handleEvent({ type: "agent_failed", error: { code: "provider_failure", message: "Provider failed" } });
		expect(tracker.getSnapshot()).toMatchObject({ phase: "idle", runningTools: 0, intent: undefined });
	});
});

describe("execution summary rendering", () => {
	it("keeps state, counts, and control labels bounded without clipped hints", () => {
		const tracker = new ExecutionStatusTracker();
		tracker.handleEvent(toolStart("a", "read", "실행 상태 확인 · 入力待ちの確認 · 检查运行状态 ".repeat(10)));
		for (const width of [0, 1, 8, 24, 48, 80, 120, 160]) {
			const rows = renderExecutionStatus(tracker.getSnapshot(), width, {
				hints: ["/jobs: details", "Esc: interrupt"],
			});
			expect(rows.length).toBeLessThanOrEqual(2);
			for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
			const plain = Bun.stripANSI(rows.join("\n"));
			if (plain.includes("/jobs")) expect(plain).toContain("/jobs: details");
			if (plain.includes("Esc")) expect(plain).toContain("Esc: interrupt");
		}
	});
	it("strips terminal control injection and preserves readable CJK text", () => {
		const tracker = new ExecutionStatusTracker();
		tracker.handleEvent(toolStart("a", "read", "你好\t검증\n\x1b[31m\x1b]0;spoofed-title\x07"));
		const rows = renderExecutionStatus(tracker.getSnapshot(), 80);
		const plain = Bun.stripANSI(rows.join("\n"));
		expect(plain).toContain("Running tools");
		expect(plain).toContain("你好 검증");
		expect(plain).toContain("1 tool running");
		expect(plain).not.toContain("spoofed-title");
		expect(rows.join("")).not.toContain("\x1b]");
	});
	it("distinguishes waiting from reasoning and hides idle state", () => {
		const tracker = new ExecutionStatusTracker();
		expect(renderExecutionStatus(tracker.getSnapshot(), 80)).toEqual([]);
		tracker.start();
		const plain = Bun.stripANSI(renderExecutionStatus(tracker.getSnapshot(), 80).join("\n"));
		expect(plain).toContain("Waiting for model");
		expect(plain).not.toContain("Thinking");
	});
});
