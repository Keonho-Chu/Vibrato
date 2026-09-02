import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as barrel from "../src/extensibility/vib-plugins";

/**
 * The Vibrato bundle lifecycle is only safe if it is the sole writer. These tests
 * pin the public boundary so a caller cannot reach a mutation primitive and
 * commit a replacement that bypasses the create-only rule.
 */

/** Symbols that would let a caller mutate bundle state outside the lifecycle. */
const FORBIDDEN_EXPORTS = [
	"runVibBundleTransaction",
	"candidateRegistryEntry",
	"resolveVibBundleCandidate",
	"writeRegistry",
	"writeRegistryUnlocked",
	"updateRegistry",
	"withRegistryLock",
];

/** The lifecycle API callers are expected to use instead. */
const REQUIRED_EXPORTS = [
	"installVibBundle",
	"previewVibBundleUpdate",
	"applyVibBundleUpdate",
	"listVibBundles",
	"getVibBundle",
	"setVibBundleEnabled",
	"setVibBundleSurfaceEnabled",
];

const srcRoot = path.join(import.meta.dir, "..", "src");
const vibPluginsRoot = path.join(srcRoot, "extensibility", "vib-plugins");
/** Only these modules may reference the writers: the owner and the primitives. */
const WRITER_OWNERS = new Set([
	path.join(vibPluginsRoot, "lifecycle.ts"),
	path.join(vibPluginsRoot, "installer.ts"),
	path.join(vibPluginsRoot, "registry.ts"),
]);

async function typescriptFilesIn(root: string): Promise<string[]> {
	const entries = await fs.readdir(root, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async entry => {
			const full = path.join(root, entry.name);
			if (entry.isDirectory()) return typescriptFilesIn(full);
			return entry.isFile() && full.endsWith(".ts") ? [full] : [];
		}),
	);
	return nested.flat();
}

describe("Vibrato plugin public boundary", () => {
	test("the barrel exposes no bundle mutation primitive", () => {
		const exported = new Set(Object.keys(barrel));
		for (const name of FORBIDDEN_EXPORTS) expect(exported.has(name)).toBe(false);
	});

	test("the barrel still exposes the lifecycle API", () => {
		const exported = new Set(Object.keys(barrel));
		for (const name of REQUIRED_EXPORTS) expect(exported.has(name)).toBe(true);
	});

	test("no production module outside the lifecycle owners references a writer", async () => {
		const files = await typescriptFilesIn(srcRoot);
		const offenders: string[] = [];
		for (const file of files) {
			if (WRITER_OWNERS.has(file)) continue;
			const text = await fs.readFile(file, "utf8");
			for (const name of ["writeRegistry", "writeRegistryUnlocked", "updateRegistry", "withRegistryLock"]) {
				if (new RegExp(`\\b${name}\\b`).test(text)) offenders.push(`${path.relative(srcRoot, file)}:${name}`);
			}
			if (/\brunVibBundleTransaction\b/.test(text)) {
				offenders.push(`${path.relative(srcRoot, file)}:runVibBundleTransaction`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("package exports do not expose writer or legacy loader modules as public subpaths", async () => {
		const manifest = JSON.parse(await fs.readFile(path.join(import.meta.dir, "..", "package.json"), "utf8")) as {
			exports: Record<string, unknown>;
		};
		const blocked = [
			"./extensibility/vib-plugins/installer",
			"./extensibility/vib-plugins/registry",
			"./extensibility/vib-plugins/loader",
			"./extensibility/vib-plugins/loader.js",
		];
		for (const key of blocked) expect(manifest.exports[key]).toBeNull();
		const keys = Object.keys(manifest.exports);
		for (const key of blocked) expect(keys.indexOf(key)).toBeLessThan(keys.indexOf("./extensibility/*"));

		for (const suffix of ["loader", "loader.js"]) {
			const child = Bun.spawnSync(
				[
					"bun",
					"-e",
					`await import(${JSON.stringify(`@vib-rato/coding-agent/extensibility/vib-plugins/${suffix}`)})`,
				],
				{ cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
			);
			expect(child.exitCode).not.toBe(0);
			expect(child.stderr.toString()).toMatch(/Cannot find module|Package subpath/);
		}
	});
});
