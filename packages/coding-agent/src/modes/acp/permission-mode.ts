import type { ClientCapabilities } from "@agentclientprotocol/sdk";

export type AcpPermissionMode = "auto" | "prompt" | "always-allow";

const ACP_PERMISSION_MODE_ENV = "VIB_ACP_PERMISSION_MODE";

function parseAcpPermissionMode(value: unknown): AcpPermissionMode {
	if (value === "auto" || value === "prompt" || value === "always-allow") return value;
	return "prompt";
}

/** Client metadata is authoritative; the process environment is only a fallback when that field is absent. */
export function resolveAcpPermissionMode(
	clientCapabilities: ClientCapabilities | undefined,
	env: NodeJS.ProcessEnv = process.env,
): AcpPermissionMode {
	const meta = clientCapabilities?._meta;
	if (typeof meta === "object" && meta !== null) {
		const vib = (meta as { vib?: unknown }).vib;
		if (typeof vib === "object" && vib !== null && "permissionHandling" in vib) {
			return parseAcpPermissionMode((vib as { permissionHandling?: unknown }).permissionHandling);
		}
	}
	return parseAcpPermissionMode(env[ACP_PERMISSION_MODE_ENV]);
}
