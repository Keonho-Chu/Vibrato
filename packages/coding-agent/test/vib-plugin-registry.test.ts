import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadEffectiveVibPluginRegistry,
	readRegistry,
	sortRegistryEntries,
	type VibPluginRegistryEntry,
} from "../src/extensibility/vib-plugins";
import { updateRegistry, writeRegistry } from "../src/extensibility/vib-plugins/registry";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

function entry(name: string, scope: "user" | "project", pluginRoot: string): VibPluginRegistryEntry {
	return {
		name,
		version: "1.0.0",
		scope,
		enabled: true,
		pluginRoot,
		manifestPath: path.join(pluginRoot, "vibrato-plugin.json"),
		manifestHash: "a".repeat(64),
		source: { kind: "path", uri: pluginRoot, resolvedAt: new Date().toISOString() },
		installedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		copiedFiles: [{ relativePath: "vibrato-plugin.json", sha256: "a".repeat(64), bytes: 10 }],
		surfaces: {
			subskills: [],
			tools: [],
			hooks: [],
			mcps: [],
			systemAppendices: [],
			agentAppendices: [],
		},
		disabledSurfaceIds: [],
	};
}

describe("Vibrato plugin registry", () => {
	test("write/read round trips a project registry", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "vib-registry-"));
		tempDirs.push(cwd);
		await fs.mkdir(path.join(cwd, ".vib", "vib-plugins"), { recursive: true });

		await writeRegistry({ version: 1, scope: "project", plugins: [entry("b", "project", "/b")] }, cwd);
		const read = await readRegistry("project", cwd);
		expect(read.plugins.map(p => p.name)).toEqual(["b"]);
		expect(read.version).toBe(1);
	});

	test("readRegistry returns empty when missing", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "vib-registry-empty-"));
		tempDirs.push(cwd);
		const read = await readRegistry("project", cwd);
		expect(read.plugins).toEqual([]);
	});

	test("updateRegistry mutates under lock and stays sorted", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "vib-registry-update-"));
		tempDirs.push(cwd);
		await fs.mkdir(path.join(cwd, ".vib", "vib-plugins"), { recursive: true });

		await updateRegistry("project", cwd, entries => [...entries, entry("zeta", "project", "/zeta")]);
		await updateRegistry("project", cwd, entries => [...entries, entry("alpha", "project", "/alpha")]);

		const read = await readRegistry("project", cwd);
		expect(read.plugins.map(p => p.name)).toEqual(["alpha", "zeta"]);
	});

	test("sortRegistryEntries orders user before project, then name, then path", () => {
		const sorted = sortRegistryEntries([
			entry("z", "user", "/z"),
			entry("a", "project", "/a"),
			entry("a", "user", "/a2"),
			entry("a", "user", "/a1"),
		]);
		expect(sorted.map(e => `${e.scope}:${e.name}:${e.pluginRoot}`)).toEqual([
			"user:a:/a1",
			"user:a:/a2",
			"user:z:/z",
			"project:a:/a",
		]);
	});

	test("loadEffectiveVibPluginRegistry merges project entries deterministically", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "vib-registry-eff-"));
		tempDirs.push(cwd);
		await fs.mkdir(path.join(cwd, ".vib", "vib-plugins"), { recursive: true });
		await writeRegistry(
			{
				version: 1,
				scope: "project",
				plugins: [entry("p2", "project", "/p2"), entry("p1", "project", "/p1")],
			},
			cwd,
		);
		const effective = await loadEffectiveVibPluginRegistry(cwd);
		const projectNames = effective.filter(e => e.scope === "project").map(e => e.name);
		expect(projectNames).toEqual(["p1", "p2"]);
	});
});
