/**
 * Managed session scope startup errors: the path-free message the session
 * manager throws, and the operator-facing recovery text the CLI prints for the
 * failures a person can fix themselves. The thrown error stays path-free (it
 * is recorded and relayed as-is); the path is added only here, on the
 * operator's own terminal.
 */

export type ManagedScopeStartupAction = "resolve" | "prepare";

const PREPARE_PREFIX = "Could not prepare managed session scope";
const RESOLVE_MESSAGE = "Could not resolve managed session scope.";

/** The message carried by a managed scope startup error. Shared with the CLI so the two cannot drift apart. */
export function managedScopeStartupErrorMessage(action: ManagedScopeStartupAction, detail: string): string {
	return action === "prepare" ? `${PREPARE_PREFIX} (${detail}).` : RESOLVE_MESSAGE;
}

function isManagedScopeStartupMessage(message: string): boolean {
	return message.startsWith(PREPARE_PREFIX) || message === RESOLVE_MESSAGE;
}

interface ManagedScopeStartupFailure {
	message: string;
	classification: string;
}

function managedScopeStartupFailure(error: unknown): ManagedScopeStartupFailure | undefined {
	if (!(error instanceof Error)) return undefined;
	if (!isManagedScopeStartupMessage(error.message)) return undefined;
	const cause = error.cause;
	if (!cause || typeof cause !== "object") return undefined;
	const classification = (cause as { classification?: unknown }).classification;
	return typeof classification === "string" ? { message: error.message, classification } : undefined;
}

function windowsOwnerMismatchRecovery(agentDir: string): string {
	return [
		`Vibrato keeps its sessions under ${agentDir}, and that directory (or a directory inside it) is owned by a different Windows account than the one running vib, and vib could not take it back.`,
		'This usually happens when the directory was created from a terminal opened with "Run as administrator", or on a machine where UAC is disabled.',
		"To recover:",
		`  1. Take the directory back: takeown /F "${agentDir}" /R /D Y`,
		"     This may itself need an administrator terminal.",
		`     On a fresh install you can delete the directory instead: Remove-Item -Recurse -Force "${agentDir}"`,
		"  2. Run vib again from a normal (non-administrator) terminal.",
		"     `whoami /groups | findstr S-1-16` prints S-1-16-8192 in a normal terminal and S-1-16-12288 in an elevated one.",
	].join("\n");
}

function posixOwnerMismatchRecovery(agentDir: string): string {
	return [
		`Vibrato keeps its sessions under ${agentDir}, and that directory (or a directory inside it) is owned by a different user than the one running vib.`,
		"This usually happens after running vib with sudo.",
		"To recover:",
		`  1. Give the directory back to your user: sudo chown -R "$(id -u)" "${agentDir}"`,
		`     On a fresh install you can delete it instead: rm -rf "${agentDir}"`,
		"  2. Run vib again without sudo.",
	].join("\n");
}

/**
 * Returns a multi-line message explaining an `owner_mismatch` managed scope
 * startup failure and how to fix it, or undefined for any other error.
 */
export function managedScopeStartupRecoveryMessage(
	error: unknown,
	agentDir: string,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const failure = managedScopeStartupFailure(error);
	if (failure?.classification !== "owner_mismatch") return undefined;
	const recovery =
		platform === "win32" ? windowsOwnerMismatchRecovery(agentDir) : posixOwnerMismatchRecovery(agentDir);
	return `${failure.message}\n${recovery}`;
}
