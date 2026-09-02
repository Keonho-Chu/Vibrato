import type { ResolvedTmuxBinary } from "./psmux-detect";
import { resolveVibTmuxBinary } from "./psmux-detect";

export {
	assertVibTmuxMutationAuthoritySync,
	bindVibTmuxProviderAuthority,
	buildTmuxProviderCommand,
	hasVibTmuxProviderAuthoritySync,
	type ProviderAuthority,
	type ProviderContext,
	persistVibTmuxProviderAuthoritySync,
	readVibTmuxProviderAuthoritySync,
	resolveVibTmuxProviderContext,
	type TmuxProviderKind,
} from "./tmux-provider-context";

export const VIB_DEFAULT_TMUX_SESSION = "vib_rato";
export const VIB_TMUX_SESSION_PREFIX = `${VIB_DEFAULT_TMUX_SESSION}_`;
export const VIB_TMUX_COMMAND_ENV = "VIB_TMUX_COMMAND";
export const VIB_TMUX_ACTIVE_SESSION_ENV = "VIB_TMUX_ACTIVE_SESSION";
export const VIB_TMUX_PROFILE_ENV = "VIB_TMUX_PROFILE";
export const VIB_TMUX_MOUSE_ENV = "VIB_MOUSE";
export const VIB_TMUX_PROFILE_OPTION = "@vib-profile";
export const VIB_TMUX_PROFILE_VALUE = "1";
export const VIB_TMUX_BRANCH_OPTION = "@vib-branch";
export const VIB_TMUX_BRANCH_SLUG_OPTION = "@vib-branch-slug";
export const VIB_TMUX_PROJECT_OPTION = "@vib-project";
export const VIB_TMUX_SESSION_ID_OPTION = "@vib-session-id";
export const VIB_TMUX_SESSION_STATE_FILE_OPTION = "@vib-session-state-file";
export const VIB_TMUX_OWNER_GENERATION_OPTION = "@vib-owner-generation";
export const VIB_TMUX_OWNER_SERVER_KEY_OPTION = "@vib-owner-server-key";

export const VIB_TMUX_VERSION_OPTION = "@vib-version";
export const VIB_PSMUX_PROFILE_FORCE_ENV = "VIB_PSMUX_PROFILE_FORCE";

export interface VibTmuxProfileCommand {
	description: string;
	args: string[];
}

export interface TmuxCommandResult {
	exitCode: number | null;
	stdout?: string;
	stderr?: string;
	signalCode?: string | null;
}

export type TmuxCommandRunner = (args: string[]) => TmuxCommandResult;

export function envDisabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no";
}

/**
 * Resolve the tmux (or tmux-compatible multiplexer) command Vibrato should invoke.
 *
 * This is the shared entry point used by every Vibrato code path that needs to talk
 * to a multiplexer: `vib --tmux` planning and `vib session ...`,
 * the lifecycle controller, and the harness resident owner. Routing all of
 * them through the same resolver means a single `VIB_TMUX_COMMAND` override or
 * a single Windows psmux / pmux detection wins for the whole process — the
 * failure mode where `vib --tmux` creates a psmux-backed session and then
 * `vib session status` fails because it queries literal `tmux` is closed off.
 *
 * Explicit `VIB_TMUX_COMMAND` overrides are honored on
 * every platform. On native Windows without an override the resolver walks
 * `psmux`, then `pmux`, then `tmux` and uses the first binary present on PATH.
 * On POSIX the resolver returns `tmux` (the historical default) and only
 * falls through to the platform-aware walker if the caller opts in.
 */
export function resolveVibTmuxCommand(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	return resolveVibTmuxBinary({ env, platform }).command;
}

export type { PsmuxProbe, ResolvedTmuxBinary, ResolveVibTmuxBinaryOptions } from "./psmux-detect";
export { clearPsmuxDetectionCache, detectPsmux, probePsmux, resolveVibTmuxBinary } from "./psmux-detect";

/**
 * Build the exact-session target for tmux *option* commands
 * (`show-options` / `set-option`) and `display-message -t`.
 *
 * Session-scoped commands such as `kill-session` / `attach-session` resolve a
 * bare exact target (`=NAME`), but tmux 3.6a refuses to resolve a bare `=NAME`
 * for option/display commands. Appending the empty window separator (`=NAME:`)
 * keeps the exact-session match while giving tmux the window-qualified target
 * those commands require. See vib-rato#580.
 */
export function buildVibTmuxExactOptionTarget(
	sessionName: string,
	opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; binary?: ResolvedTmuxBinary } = {},
): string {
	const binary = opts.binary ?? resolveVibTmuxBinary({ env: opts.env, platform: opts.platform });
	// psmux 3.3.0 rejects the tmux `=NAME` exact-session prefix for option
	// commands ("no server running on session '=NAME'"); bare `NAME` and
	// window-qualified `NAME:` both work. tmux 3.6a needs the
	// window-qualified `=NAME:` to resolve the session for option
	// commands (vib-rato#580).
	if (binary.isPsmux) return sessionName;
	return `=${sessionName}:`;
}

/**
 * Build the exact-session target for tmux *session-scoped* commands such as
 * `attach-session` and `kill-session`. Native tmux accepts `=NAME` for an
 * exact session match, but Windows psmux 3.3.x rejects that target form for
 * session commands even though the bare `NAME` resolves. Keep native tmux on
 * exact targets and intentionally use the bare session name for psmux.
 */
export function buildVibTmuxExactSessionTarget(
	sessionName: string,
	opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; binary?: ResolvedTmuxBinary } = {},
): string {
	const binary = opts.binary ?? resolveVibTmuxBinary({ env: opts.env, platform: opts.platform });
	if (binary.isPsmux) return sessionName;
	return `=${sessionName}`;
}

export const VIB_TMUX_UNTAGGED_REASON = "vib_tmux_session_untagged";

export function buildVibTmuxUntaggedSessionHint(tmuxCommand: string): string {
	return (
		`the active multiplexer "${tmuxCommand}" lists this session but did not return Vibrato's ${VIB_TMUX_PROFILE_OPTION} ownership tag; ` +
		"Vibrato-managed sessions require a tmux provider that round-trips tmux user options. " +
		"On Windows psmux, Vibrato persists a ProviderAuthority that binds the exact executable identity and an isolated `-L <namespace>` server namespace for the owner generation. " +
		"Recover through Vibrato so it reuses that persisted authority; do not retry against ambient tmux/psmux or a raw `-L` namespace. " +
		"VIB_TMUX_COMMAND is a binary override, not a shell command line."
	);
}

export function buildVibTmuxUntaggedSessionError(sessionName: string, tmuxCommand: string): string {
	return `${VIB_TMUX_UNTAGGED_REASON}:${sessionName} — ${buildVibTmuxUntaggedSessionHint(tmuxCommand)}`;
}

export function sanitizeTmuxToken(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "default"
	);
}

export function buildVibTmuxSessionSlug(value: string): string {
	return sanitizeTmuxToken(value);
}

function randomTmuxSessionSuffix(): string {
	return Math.random().toString(36).slice(2, 10);
}

export function buildVibTmuxSessionName(
	env: NodeJS.ProcessEnv = process.env,
	context: { branch?: string | null; now?: number; id?: string } = {},
): string {
	const explicit = env.VIB_TMUX_SESSION?.trim();
	if (explicit) return explicit;
	const timestamp = (context.now ?? Date.now()).toString(36);
	const id = context.id ?? randomTmuxSessionSuffix();
	const branchSlug = context.branch ? `${buildVibTmuxSessionSlug(context.branch)}_` : "";
	return `${VIB_TMUX_SESSION_PREFIX}${branchSlug}${timestamp}_${id}`;
}

export function buildVibTmuxRequiredProfileCommands(
	target: string,
	metadata: {
		branch?: string | null;
		branchSlug?: string | null;
		project?: string | null;
		sessionId?: string | null;
		sessionStateFile?: string | null;
		ownerGeneration?: string | null;
		ownerServerKey?: string | null;
		version?: string | null;
	} = {},
): VibTmuxProfileCommand[] {
	const commands: VibTmuxProfileCommand[] = [];

	if (metadata.branch)
		commands.push({
			description: "record Vibrato branch identity",
			args: ["set-option", "-t", target, VIB_TMUX_BRANCH_OPTION, metadata.branch],
		});
	if (metadata.branchSlug)
		commands.push({
			description: "record Vibrato branch slug",
			args: ["set-option", "-t", target, VIB_TMUX_BRANCH_SLUG_OPTION, metadata.branchSlug],
		});
	if (metadata.project)
		commands.push({
			description: "record Vibrato project identity",
			args: ["set-option", "-t", target, VIB_TMUX_PROJECT_OPTION, metadata.project],
		});
	if (metadata.sessionId)
		commands.push({
			description: "record Vibrato session identity",
			args: ["set-option", "-t", target, VIB_TMUX_SESSION_ID_OPTION, metadata.sessionId],
		});
	if (metadata.sessionStateFile)
		commands.push({
			description: "record Vibrato session state marker",
			args: ["set-option", "-t", target, VIB_TMUX_SESSION_STATE_FILE_OPTION, metadata.sessionStateFile],
		});
	if (metadata.ownerGeneration)
		commands.push({
			description: "record Vibrato owner generation",
			args: ["set-option", "-t", target, VIB_TMUX_OWNER_GENERATION_OPTION, metadata.ownerGeneration],
		});
	if (metadata.ownerServerKey)
		commands.push({
			description: "record Vibrato owner server key",
			args: ["set-option", "-t", target, VIB_TMUX_OWNER_SERVER_KEY_OPTION, metadata.ownerServerKey],
		});

	if (metadata.version)
		commands.push({
			description: "record Vibrato version identity",
			args: ["set-option", "-t", target, VIB_TMUX_VERSION_OPTION, metadata.version],
		});
	commands.push({
		description: "mark Vibrato tmux ownership",
		args: ["set-option", "-t", target, VIB_TMUX_PROFILE_OPTION, VIB_TMUX_PROFILE_VALUE],
	});
	return commands;
}

/**
 * Keys whose set-option / set-window-option round-trip is unreliable on psmux
 * 3.3.0. psmux does not support the tmux `set-window-option` command at all
 * (it reports "unknown command: set-window-option") and silently drops several
 * `set-option` keys. The list lives here so every code path that tags a tmux
 * session (vib --tmux planning, vib session create)
 * applies the same filter.
 */
const PSMUX_UNSUPPORTED_PROFILE_KEYS = new Set(["mouse", "set-clipboard", "mode-style"]);

export function buildVibTmuxProfileCommands(
	target: string,
	env: NodeJS.ProcessEnv = process.env,
	metadata: {
		branch?: string | null;
		branchSlug?: string | null;
		project?: string | null;
		sessionId?: string | null;
		sessionStateFile?: string | null;
		ownerGeneration?: string | null;
		ownerServerKey?: string | null;
		version?: string | null;
	} = {},
	opts: { platform?: NodeJS.Platform; tmuxCommand?: string } = {},
): VibTmuxProfileCommand[] {
	const commands = buildVibTmuxRequiredProfileCommands(target, metadata);
	if (envDisabled(env[VIB_TMUX_PROFILE_ENV])) return commands;
	commands.push(
		{ description: "enable tmux clipboard integration", args: ["set-option", "-t", target, "set-clipboard", "on"] },
		{
			description: "make copy-mode selection readable",
			args: ["set-window-option", "-t", target, "mode-style", "fg=colour231,bg=colour60"],
		},
	);
	if (!envDisabled(env[VIB_TMUX_MOUSE_ENV]))
		commands.unshift({
			description: "enable tmux mouse scrolling",
			args: ["set-option", "-t", target, "mouse", "on"],
		});
	// psmux does not implement set-window-option and historically drops
	// mouse / set-clipboard / mode-style. Filter the UX profile commands
	// centrally so every code path that tags a session (vib --tmux planning,
	// vib session create) drops the same set. The
	// VIB_PSMUX_PROFILE_FORCE override lets the operator opt back in when
	// running on a psmux build that has caught up. The ownership-tag
	// round-trip (set-option @vib-*) is never filtered, since vib session /
	// tmux-backed sessions rely on it.
	// The filter is opt-in: callers that explicitly pass `opts.tmuxCommand`
	// name a psmux-class multiplexer (psmux / pmux) when they want the UX
	// profile filtered. Auto-detect on Windows hosts where psmux happens
	// to be on PATH would silently change the test output for every caller
	// that does not pin the multiplexer, so we require the caller to opt
	// in by naming the multiplexer. VIB_PSMUX_PROFILE_FORCE re-enables
	// the UX profile commands when a psmux build catches up.
	const tmuxName = (opts.tmuxCommand ?? "").toLowerCase();
	const isPsmuxClass =
		tmuxName === "psmux" ||
		tmuxName === "pmux" ||
		tmuxName.endsWith("/psmux") ||
		tmuxName.endsWith("/pmux") ||
		tmuxName.endsWith("\\psmux") ||
		tmuxName.endsWith("\\pmux");
	const forcePsmuxProfile = env[VIB_PSMUX_PROFILE_FORCE_ENV] === "true" || env[VIB_PSMUX_PROFILE_FORCE_ENV] === "1";
	const dropUx = isPsmuxClass && !forcePsmuxProfile;
	if (dropUx) {
		return commands.filter(command => {
			const flag = command.args[0];
			const key = command.args[command.args.length - 2];
			return !(
				PSMUX_UNSUPPORTED_PROFILE_KEYS.has(String(key)) &&
				(flag === "set-option" || flag === "set-window-option")
			);
		});
	}
	return commands;
}

export function normalizeTmuxCreatedAt(raw: string): string {
	const seconds = Number.parseInt(raw, 10);
	if (!Number.isFinite(seconds) || seconds <= 0) return raw;
	return new Date(seconds * 1000).toISOString();
}
