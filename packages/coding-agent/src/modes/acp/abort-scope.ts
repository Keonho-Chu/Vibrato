import type { AbortScope } from "../../sdk/host/control/operations";

const ACP_ABORT_SCOPE_ENV = "VIB_ACP_ABORT_SCOPE";

function parseAcpAbortScope(value: unknown): AbortScope {
	if (value === "turn" || value === "owned") return value;
	return "turn";
}

/**
 * Resolves the C04 terminal-abort scope for an ACP `session/cancel`. Client
 * metadata is authoritative; the process environment is only a fallback when
 * that field is absent. Both default to `"turn"` so an external client that
 * ends a turn only stops that turn, matching the SDK `turn.abort` default and
 * other ACP clients' cancel behavior; a client that also wants exact owned
 * subagents and background tasks stopped opts in per request with
 * `_meta.vib.abortScope: "owned"` (or process-wide with
 * `VIB_ACP_ABORT_SCOPE=owned`). Paseo keeps owned cancels through its provider
 * config `env: { "VIB_ACP_ABORT_SCOPE": "owned" }` without source changes.
 */
export function resolveAcpAbortScope(meta: unknown, env: NodeJS.ProcessEnv = process.env): AbortScope {
	if (typeof meta === "object" && meta !== null) {
		const vib = (meta as { vib?: unknown }).vib;
		if (typeof vib === "object" && vib !== null && "abortScope" in vib) {
			return parseAcpAbortScope((vib as { abortScope?: unknown }).abortScope);
		}
	}
	return parseAcpAbortScope(env[ACP_ABORT_SCOPE_ENV]);
}
