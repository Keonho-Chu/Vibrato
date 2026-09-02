import { promises as fs } from "node:fs";
import * as path from "node:path";
import { getAgentDir, pathIsWithin } from "@vib-rato/utils";
import { VIB_PLUGIN_MANIFEST_FILENAME, VibPluginLoadError } from "./types";

export function vibPluginUserRoot(): string {
	return path.join(getAgentDir(), "vib-plugins");
}

export function vibPluginProjectRoot(cwd: string): string {
	return path.join(cwd, ".vib", "vib-plugins");
}

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function rootContainsVibManifest(dir: string): Promise<boolean> {
	try {
		await fs.access(path.join(dir, VIB_PLUGIN_MANIFEST_FILENAME));
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function discoverVibPluginRootsIn(baseDir: string): Promise<string[]> {
	if (await rootContainsVibManifest(baseDir)) return [baseDir];

	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(baseDir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}

	const roots = await Promise.all(
		entries
			.filter(entry => entry.isDirectory() || entry.isSymbolicLink())
			.map(async entry => {
				const dir = path.join(baseDir, entry.name);
				return (await rootContainsVibManifest(dir)) ? dir : null;
			}),
	);

	return roots.filter((root): root is string => root !== null).sort((a, b) => a.localeCompare(b));
}

export async function discoverVibPluginRoots({ cwd }: { cwd: string; home?: string }): Promise<string[]> {
	const roots = await Promise.all([
		discoverVibPluginRootsIn(vibPluginUserRoot()),
		discoverVibPluginRootsIn(vibPluginProjectRoot(cwd)),
	]);
	return roots.flat();
}

export function resolveWithinRoot(root: string, rel: string): string {
	const resolvedRoot = path.resolve(root);
	const resolvedPath = path.resolve(resolvedRoot, rel);
	if (!pathIsWithin(resolvedRoot, resolvedPath)) {
		throw new VibPluginLoadError("missing_file", `Vibrato plugin path escapes root: ${rel}`);
	}
	return resolvedPath;
}
