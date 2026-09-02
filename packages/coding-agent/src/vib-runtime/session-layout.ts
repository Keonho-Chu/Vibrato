/**
 * Pure path layout for session-scoped Vibrato workflow state.
 *
 * Every generated/runtime artifact for a Vibrato session lives under
 * `<cwd>/.vib/_session-{encodedSessionId}/...`. The `_session-` prefix is what
 * discriminates a session directory from shared, user-authored/installed config
 * (settings.json, secrets.yml, agents/, vib-plugins/, agent/, python-env/, user
 * skills/commands), which always stays at the `.vib/` root.
 *
 * This module is PURE and acyclic: every export is a deterministic function of
 * its arguments. It never reads `process.env` and never touches the filesystem.
 * Session resolution (flag/payload/env/latest-activity-marker) and any
 * filesystem scanning live in `session-resolution.ts`, the boundary module.
 */
import * as path from "node:path";

export const VIB_DIR = ".vib";
export const VIB_SESSION_PREFIX = "_session-";
export const VIB_SESSION_ACTIVITY_FILE = ".session-activity.json";

/** Source that produced a resolved Vibrato session id, for audit/diagnostics. */
export type VibSessionSource = "flag" | "payload" | "env" | "latest";

export interface VibSessionContext {
	vibSessionId: string;
	sessionRoot: string;
	source: VibSessionSource;
}

/**
 * Encode a session id into a single safe path segment. Matches the historical
 * encoding used across the runtimes so ids round-trip identically:
 * `encodeURIComponent` plus dot-escaping (dots are legal in filenames but we
 * avoid `.`/`..` traversal ambiguity).
 */
export function encodeSessionSegment(value: string): string {
	return encodeURIComponent(value).replaceAll(".", "%2E");
}

/** Inverse of {@link encodeSessionSegment}. */
export function decodeSessionSegment(segment: string): string {
	return decodeURIComponent(segment.replaceAll("%2E", "."));
}

/** Throw when a session id is missing or blank; never let blank suppress callers. */
export function assertNonEmptyVibSessionId(value: string | undefined, source: string): asserts value is string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`a non-empty Vibrato session id is required (${source})`);
	}
}

/**
 * Assert a value is safe to use as a single path segment: non-blank and free of
 * path separators or `.`/`..` traversal. Use for already-safe identifiers
 * (skill modes, slugs) where we want identical filenames but fail closed on
 * traversal rather than silently normalizing out of the intended directory.
 */
export function assertSafePathComponent(value: string, label: string): void {
	const trimmed = value.trim();
	if (trimmed === "") throw new Error(`${label} is required`);
	if (trimmed === "." || trimmed === ".." || /[/\\]/.test(trimmed)) {
		throw new Error(`${label} must be a safe path component (no separators or traversal): ${value}`);
	}
}

/** The shared `.vib/` root (holds shared config; never session-scoped). */
export function vibRoot(cwd: string): string {
	return path.join(cwd, VIB_DIR);
}

/** The per-session root directory: `<cwd>/.vib/_session-{encodedId}`. */
export function sessionRoot(cwd: string, vibSessionId: string): string {
	assertNonEmptyVibSessionId(vibSessionId, "sessionRoot");
	return path.join(vibRoot(cwd), `${VIB_SESSION_PREFIX}${encodeSessionSegment(vibSessionId)}`);
}

/** Directory name (no path) for a session id, e.g. `_session-abc`. */
export function sessionDirName(vibSessionId: string): string {
	assertNonEmptyVibSessionId(vibSessionId, "sessionDirName");
	return `${VIB_SESSION_PREFIX}${encodeSessionSegment(vibSessionId)}`;
}

/** Return the decoded session id for a `_session-*` directory name, else undefined. */
export function sessionIdFromDirName(name: string): string | undefined {
	if (!name.startsWith(VIB_SESSION_PREFIX)) return undefined;
	const suffix = name.slice(VIB_SESSION_PREFIX.length);
	if (suffix === "") return undefined;
	let decoded: string;
	try {
		decoded = decodeSessionSegment(suffix);
	} catch {
		return undefined;
	}
	return decoded.trim() === "" ? undefined : decoded;
}

/** Authoritative per-session activity marker path. */
export function sessionActivityPath(cwd: string, vibSessionId: string): string {
	return path.join(sessionRoot(cwd, vibSessionId), VIB_SESSION_ACTIVITY_FILE);
}

// ---- Top-level per-category subdir resolvers ----

export function sessionStateDir(cwd: string, vibSessionId: string): string {
	return path.join(sessionRoot(cwd, vibSessionId), "state");
}
export function sessionSpecsDir(cwd: string, vibSessionId: string): string {
	return path.join(sessionRoot(cwd, vibSessionId), "specs");
}
export function sessionPlansDir(cwd: string, vibSessionId: string): string {
	return path.join(sessionRoot(cwd, vibSessionId), "plans");
}
export function sessionUltragoalDir(cwd: string, vibSessionId: string): string {
	return path.join(sessionRoot(cwd, vibSessionId), "ultragoal");
}
export function sessionAuditDir(cwd: string, vibSessionId: string): string {
	return path.join(sessionRoot(cwd, vibSessionId), "audit");
}
export function sessionReportsDir(cwd: string, vibSessionId: string): string {
	return path.join(sessionRoot(cwd, vibSessionId), "reports");
}
export function sessionLogsDir(cwd: string, vibSessionId: string): string {
	return path.join(sessionRoot(cwd, vibSessionId), "logs");
}
export function sessionRuntimeDir(cwd: string, vibSessionId: string): string {
	return path.join(sessionRoot(cwd, vibSessionId), "runtime");
}
export function sessionIpykernelsDir(cwd: string, vibSessionId: string): string {
	return path.join(sessionRoot(cwd, vibSessionId), "ipykernels");
}
export function sessionIpykernelsArtifactsDir(cwd: string, vibSessionId: string): string {
	return path.join(sessionIpykernelsDir(cwd, vibSessionId), "artifacts");
}
export function pythonKernelTranscriptPath(cwd: string, vibSessionId: string, dirName: string): string {
	const normalized = dirName.trim();
	assertSafePathComponent(normalized, "python kernel transcript dirName");
	return path.join(sessionIpykernelsDir(cwd, vibSessionId), normalized, "transcript.jsonl");
}
export function sessionAutoresearchDir(cwd: string, vibSessionId: string): string {
	return path.join(sessionRoot(cwd, vibSessionId), "autoresearch");
}
export function sessionAutoresearchRunsDir(cwd: string, vibSessionId: string): string {
	return path.join(sessionAutoresearchDir(cwd, vibSessionId), "runs");
}

// ---- Nested resolvers under <sessionRoot>/state ----

export function activeStateDir(cwd: string, vibSessionId: string): string {
	return path.join(sessionStateDir(cwd, vibSessionId), "active");
}
export function activeSnapshotPath(cwd: string, vibSessionId: string): string {
	return path.join(sessionStateDir(cwd, vibSessionId), "skill-active-state.json");
}
export function activeEntryPath(cwd: string, vibSessionId: string, skill: string): string {
	const normalized = skill.trim();
	if (normalized === "") throw new Error("skill is required");
	return path.join(activeStateDir(cwd, vibSessionId), `${encodeSessionSegment(normalized)}.json`);
}
export function modeStatePath(cwd: string, vibSessionId: string, mode: string): string {
	const normalized = mode.trim();
	assertSafePathComponent(normalized, "mode");
	return path.join(sessionStateDir(cwd, vibSessionId), `${normalized}-state.json`);
}
export function auditPath(cwd: string, vibSessionId: string): string {
	return path.join(sessionStateDir(cwd, vibSessionId), "audit.jsonl");
}
export function transactionJournalPath(cwd: string, vibSessionId: string, mutationId: string): string {
	return path.join(sessionStateDir(cwd, vibSessionId), "transactions", `${encodeSessionSegment(mutationId)}.json`);
}
export function workflowGatePath(cwd: string, vibSessionId: string, gateId: string): string {
	return path.join(sessionStateDir(cwd, vibSessionId), "workflow-gates", `${encodeSessionSegment(gateId)}.json`);
}
export function harnessStateRoot(cwd: string, vibSessionId: string): string {
	return path.join(sessionStateDir(cwd, vibSessionId), "harness");
}
export function coordinatorMcpStateRoot(cwd: string, vibSessionId: string): string {
	return path.join(sessionStateDir(cwd, vibSessionId), "coordinator-mcp");
}

// ---- Nested resolvers under other top-level categories ----

export function tmuxRuntimeSessionPath(cwd: string, vibSessionId: string, slug: string): string {
	const normalized = slug.trim();
	assertSafePathComponent(normalized, "slug");
	return path.join(sessionRuntimeDir(cwd, vibSessionId), "tmux-sessions", `${normalized}.json`);
}
export function autoresearchRlmArtifactRoot(cwd: string, vibSessionId: string, rlmSessionId: string): string {
	const normalized = rlmSessionId.trim();
	if (normalized === "") throw new Error("rlmSessionId is required");
	return path.join(sessionAutoresearchRunsDir(cwd, vibSessionId), encodeSessionSegment(normalized));
}
