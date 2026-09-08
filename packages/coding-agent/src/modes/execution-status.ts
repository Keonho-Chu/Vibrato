import { parseRateLimitReason } from "@vib-rato/ai/core";
import type { AgentSessionEvent } from "../session/agent-session";

export type ExecutionPhase =
	| "idle"
	| "model"
	| "response"
	| "tools"
	| "retry"
	| "compaction"
	| "input"
	| "background"
	| "queued";
export interface ExecutionStatusContext {
	backgroundTasks: number;
	queuedMessages: number;
	backgroundStartedAt?: number;
}
export interface ExecutionStatusSnapshot {
	phase: ExecutionPhase;
	elapsedMs: number;
	runningTools: number;
	completedTools: number;
	failedTools: number;
	backgroundTasks: number;
	queuedMessages: number;
	inputRequests: number;
	toolName?: string;
	intent?: string;
	retryAttempt?: number;
	retryMaxAttempts?: number;
	retryInMs?: number;
	retryReason?: string;
}

interface ExecutingTool {
	name: string;
	intent?: string;
}
interface RetryState {
	attempt: number;
	maxAttempts?: number;
	deadline: number;
	reason: string;
}

/** Shared with the retry loader so both surfaces name the same cause, never the provider's text. */
export function friendlyRetryReason(errorMessage: string | undefined): string {
	if (!errorMessage) return "";
	switch (parseRateLimitReason(errorMessage)) {
		case "RATE_LIMIT_EXCEEDED":
			return "rate limited";
		case "QUOTA_EXHAUSTED":
			return "usage limit";
		case "MODEL_CAPACITY_EXHAUSTED":
			return "overloaded";
		case "SERVER_ERROR":
			return "server error";
		default:
			return /network|connection|socket|fetch failed|terminated|timeout|timed out|stream/i.test(errorMessage)
				? "connection error"
				: "transient error";
	}
}
function nonnegativeCount(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
function isBackgroundHandoff(details: unknown): boolean {
	if (!details || typeof details !== "object" || !("async" in details)) return false;
	const asyncDetails = details.async;
	return (
		!!asyncDetails && typeof asyncDetails === "object" && "state" in asyncDetails && asyncDetails.state === "running"
	);
}

/** Read-only UI projection: execution events, never prose or streamed tool cards, own lifecycle. */
export class ExecutionStatusTracker {
	readonly #onChange: (() => void) | undefined;
	readonly #now: () => number;
	#active = false;
	#promptOpen = false;
	#responding = false;
	#phase: ExecutionPhase = "idle";
	#phaseSince: number | undefined;
	readonly #tools = new Map<string, ExecutingTool>();
	readonly #seenTools = new Set<string>();
	readonly #inputLeases = new Set<symbol>();
	readonly #maintenanceLeases = new Set<symbol>();
	#completed = 0;
	#failed = 0;
	#retry: RetryState | undefined;
	#maintenance = false;

	constructor(onChange?: () => void, now: () => number = Date.now) {
		this.#onChange = onChange;
		this.#now = now;
	}

	#beginForeground(): void {
		if (!this.#promptOpen) {
			this.#completed = 0;
			this.#failed = 0;
			this.#seenTools.clear();
			this.#promptOpen = true;
		}
		this.#active = true;
	}

	#currentPhase(): ExecutionPhase {
		if (this.#inputLeases.size) return "input";
		if (this.#retry) return "retry";
		if (this.#maintenance || this.#maintenanceLeases.size > 0) return "compaction";
		if (this.#tools.size) return "tools";
		if (this.#active) return this.#responding ? "response" : "model";
		return "idle";
	}

	#publish(restartClock = false): void {
		const phase = this.#currentPhase();
		if (phase !== this.#phase || restartClock) {
			this.#phase = phase;
			this.#phaseSince = phase === "idle" ? undefined : this.#now();
		}
		this.#onChange?.();
	}

	start(): void {
		if (this.#active) return;
		this.#beginForeground();
		this.#publish();
	}

	/** Loader suspension retires foreground activity, not separately owned maintenance or input. */
	stop(): void {
		this.#active = false;
		this.#responding = false;
		this.#tools.clear();
		if (!this.#retry && !this.#maintenance && this.#maintenanceLeases.size === 0) this.#promptOpen = false;
		this.#publish();
	}

	reset(): void {
		this.#active = false;
		this.#promptOpen = false;
		this.#responding = false;
		this.#tools.clear();
		this.#seenTools.clear();
		this.#inputLeases.clear();
		this.#maintenanceLeases.clear();
		this.#completed = 0;
		this.#failed = 0;
		this.#retry = undefined;
		this.#maintenance = false;
		this.#publish();
	}

	beginInput(): () => void {
		const lease = Symbol("execution-input");
		this.#inputLeases.add(lease);
		this.#publish();
		return () => {
			if (this.#inputLeases.delete(lease)) this.#publish();
		};
	}

	beginMaintenance(): () => void {
		const lease = Symbol("execution-maintenance");
		this.#maintenanceLeases.add(lease);
		this.#publish();
		return () => {
			if (this.#maintenanceLeases.delete(lease)) this.#publish();
		};
	}

	handleEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start": {
				const continuing = this.#retry !== undefined || this.#maintenance;
				if (!continuing) this.#promptOpen = false;
				// A run that restarts after a retry or maintenance never resumes a
				// tool: an entry still here has no end event coming.
				this.#tools.clear();
				this.#retry = undefined;
				this.#maintenance = false;
				this.#responding = false;
				this.#beginForeground();
				this.#publish(!continuing && this.#inputLeases.size === 0);
				break;
			}
			case "agent_end":
			case "agent_failed":
				this.#retry = undefined;
				this.#maintenance = false;
				this.stop();
				break;
			case "turn_start":
				if (!this.#active) break;
				this.#responding = false;
				this.#publish();
				break;
			case "message_start":
			case "message_update": {
				if (!this.#active || this.#responding || event.message.role !== "assistant") break;
				const hasContent = event.message.content.some(content =>
					content.type === "text"
						? content.text.length > 0
						: content.type === "thinking"
							? content.thinking.length > 0
							: content.type === "toolCall",
				);
				if (hasContent) {
					this.#responding = true;
					this.#publish();
				}
				break;
			}
			case "message_end":
				if (event.message.role === "assistant" && this.#responding) {
					this.#responding = false;
					this.#publish();
				}
				break;
			case "tool_execution_start":
				if (this.#seenTools.has(event.toolCallId)) break;
				this.#beginForeground();
				this.#seenTools.add(event.toolCallId);
				this.#tools.set(event.toolCallId, {
					name: event.toolName,
					intent: typeof event.intent === "string" ? event.intent : undefined,
				});
				this.#responding = false;
				this.#publish();
				break;
			case "tool_execution_end":
				if (!this.#tools.delete(event.toolCallId)) break;
				if (!isBackgroundHandoff(event.result.details)) {
					if (event.isError) this.#failed++;
					else this.#completed++;
				}
				this.#responding = false;
				this.#publish();
				break;
			case "auto_retry_start":
				this.#retry = {
					attempt: event.attempt,
					maxAttempts: event.unbounded ? undefined : event.maxAttempts,
					deadline: this.#now() + Math.max(0, event.delayMs),
					reason: friendlyRetryReason(event.errorMessage),
				};
				this.#responding = false;
				this.#publish(this.#inputLeases.size === 0);
				break;
			case "auto_retry_end":
				this.#retry = undefined;
				if (!event.success) this.stop();
				else this.#publish();
				break;
			case "auto_compaction_start":
				this.#maintenance = true;
				this.#responding = false;
				this.#publish();
				break;
			case "auto_compaction_end":
				this.#maintenance = false;
				if (event.willRetry) this.#beginForeground();
				else {
					this.#active = false;
					this.#promptOpen = false;
					this.#tools.clear();
				}
				this.#publish();
				break;
		}
	}

	getSnapshot(context: ExecutionStatusContext = { backgroundTasks: 0, queuedMessages: 0 }): ExecutionStatusSnapshot {
		const now = this.#now();
		const backgroundTasks = nonnegativeCount(context.backgroundTasks);
		const queuedMessages = nonnegativeCount(context.queuedMessages);
		let phase = this.#phase;
		let since = this.#phaseSince;
		if (phase === "idle" && backgroundTasks > 0) {
			phase = "background";
			since = context.backgroundStartedAt;
		} else if (phase === "idle" && queuedMessages > 0) phase = "queued";
		const tool = this.#tools.values().next().value;
		return {
			phase,
			elapsedMs: since === undefined || !Number.isFinite(since) ? 0 : Math.max(0, now - since),
			runningTools: this.#tools.size,
			// Counts describe the current prompt; a phase derived from background
			// or queued work after the prompt ended must not carry them.
			completedTools: this.#phase === "idle" ? 0 : this.#completed,
			failedTools: this.#phase === "idle" ? 0 : this.#failed,
			backgroundTasks,
			queuedMessages,
			inputRequests: this.#inputLeases.size,
			toolName: tool?.name,
			intent: tool?.intent,
			retryAttempt: this.#retry?.attempt,
			retryMaxAttempts: this.#retry?.maxAttempts,
			retryInMs: this.#retry ? Math.max(0, this.#retry.deadline - now) : undefined,
			retryReason: this.#retry?.reason,
		};
	}
}
