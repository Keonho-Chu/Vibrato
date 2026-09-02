import process from "node:process";

import { $pickenv } from "@vib-rato/utils";

interface VibCommand {
	cmd: string;
	args: string[];
	shell: boolean;
}

const DEFAULT_CMD = process.platform === "win32" ? "vib.cmd" : "vib";
const DEFAULT_SHELL = process.platform === "win32";

export function resolveVibCommand(): VibCommand {
	const envCmd = $pickenv("VIB_SUBPROCESS_CMD", "PI_SUBPROCESS_CMD");
	if (envCmd?.trim()) {
		return { cmd: envCmd, args: [], shell: DEFAULT_SHELL };
	}

	const entry = process.argv[1];
	if (entry && (entry.endsWith(".ts") || entry.endsWith(".js"))) {
		return { cmd: process.execPath, args: [entry], shell: false };
	}

	return { cmd: DEFAULT_CMD, args: [], shell: DEFAULT_SHELL };
}
