import { truncateToWidth, visibleWidth } from "@vib-rato/tui";
import { formatDuration } from "@vib-rato/utils";
import type { ExecutionPhase, ExecutionStatusSnapshot } from "../execution-status";
import { sanitizeStatusText } from "../shared";
import { theme } from "../theme/theme";

export interface ExecutionStatusRenderOptions {
	workingMessage?: string;
	hints?: readonly string[];
}

const LABELS: Record<ExecutionPhase, readonly [string, string]> = {
	idle: ["", ""],
	model: ["Waiting for model", "Model wait"],
	response: ["Receiving response", "Response"],
	tools: ["Running tools", "Tools"],
	retry: ["Waiting to retry", "Retry wait"],
	compaction: ["Context maintenance", "Context"],
	input: ["Waiting for input", "Input needed"],
	background: ["Background work", "Background"],
	queued: ["Messages queued", "Queued"],
};

function seconds(milliseconds: number): string {
	const whole = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
	return whole === 0 ? "0s" : formatDuration(whole * 1000);
}
function countLabel(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

/** Uncached, render-only summary. Optional count/action chunks are never partially printed. */
export function renderExecutionStatus(
	snapshot: ExecutionStatusSnapshot,
	width: number,
	options: ExecutionStatusRenderOptions = {},
): string[] {
	if (!Number.isFinite(width) || width <= 0 || snapshot.phase === "idle") return [];
	width = Math.floor(width);
	if (width === 0) return [];
	const [label, compactLabel] = LABELS[snapshot.phase];
	const status = visibleWidth(label) <= width ? label : compactLabel;
	const color = snapshot.phase === "input" || snapshot.phase === "retry" ? "warning" : "accent";
	let first = truncateToWidth(theme.fg(color, status), width);
	const appendFirst = (part: string): boolean => {
		if (visibleWidth(first) + visibleWidth(part) + 3 > width) return false;
		first += theme.fg("muted", " · ") + part;
		return true;
	};
	if (snapshot.phase !== "queued") appendFirst(theme.fg("muted", seconds(snapshot.elapsedMs)));
	if (snapshot.phase === "retry") {
		if (snapshot.retryInMs !== undefined) appendFirst(theme.fg("warning", `retry in ${seconds(snapshot.retryInMs)}`));
		if (snapshot.retryAttempt !== undefined) {
			appendFirst(
				theme.fg(
					"muted",
					`attempt ${snapshot.retryAttempt}${snapshot.retryMaxAttempts === undefined ? "" : `/${snapshot.retryMaxAttempts}`}`,
				),
			);
		}
		if (snapshot.retryReason) appendFirst(theme.fg("muted", sanitizeStatusText(snapshot.retryReason)));
	} else {
		const detail = sanitizeStatusText(snapshot.intent ?? options.workingMessage ?? snapshot.toolName ?? "");
		const available = width - visibleWidth(first) - 3;
		if (detail && available >= 8) first += theme.fg("muted", ` · ${truncateToWidth(detail, available)}`);
	}

	const chunks: string[] = [];
	if (snapshot.failedTools > 0)
		chunks.push(theme.fg("error", `${countLabel(snapshot.failedTools, "tool", "tools")} failed`));
	if (snapshot.runningTools > 0)
		chunks.push(theme.fg("muted", `${countLabel(snapshot.runningTools, "tool", "tools")} running`));
	if (snapshot.completedTools > 0)
		chunks.push(theme.fg("muted", `${countLabel(snapshot.completedTools, "tool", "tools")} done`));
	if (snapshot.backgroundTasks > 0) chunks.push(theme.fg("muted", `${snapshot.backgroundTasks} background`));
	if (snapshot.queuedMessages > 0) chunks.push(theme.fg("muted", `${snapshot.queuedMessages} queued`));
	if (snapshot.inputRequests > 1) chunks.push(theme.fg("warning", `${snapshot.inputRequests} input requests`));
	for (const hint of options.hints ?? []) {
		const text = sanitizeStatusText(hint);
		if (text) chunks.push(theme.fg("dim", text));
	}
	let second = "";
	for (const chunk of chunks) {
		const separator = second ? theme.fg("muted", " · ") : "";
		if (visibleWidth(second) + visibleWidth(separator) + visibleWidth(chunk) <= width) second += separator + chunk;
	}
	return second ? [first, second] : [first];
}
