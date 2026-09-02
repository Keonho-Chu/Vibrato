import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@vib-rato/utils";
import {
	applyVibBundleUpdate,
	bundleIdentity,
	getVibBundle,
	installVibBundle,
	listVibBundles,
	previewVibBundleUninstall,
	previewVibBundleUpdate,
	readRegistry,
	redactSourceLocator,
	registryPathForScope,
	setVibBundleEnabled,
	setVibBundleSurfaceEnabled,
	uninstallVibBundle,
	type VibBundleIdentity,
} from "../src/extensibility/vib-plugins";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "vib-plugins");
const sixSurface = path.join(fixturesRoot, "valid-six-surface-bundle");
const tempDirs: string[] = [];
const originalAgentDir = getAgentDir();
let agentDir: string;

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "vib-lifecycle-agent-"));
	setAgentDir(agentDir);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
	await fs.rm(agentDir, { recursive: true, force: true });
});

async function mkProjectCwd(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "vib-lifecycle-"));
	tempDirs.push(cwd);
	return cwd;
}

async function mkSource(): Promise<string> {
	const source = await fs.mkdtemp(path.join(os.tmpdir(), "vib-lifecycle-source-"));
	tempDirs.push(source);
	await fs.cp(sixSurface, source, { recursive: true });
	return source;
}

async function rewriteManifest(source: string, version: string, tools: string): Promise<void> {
	const manifestPath = path.join(source, "vibrato-plugin.json");
	const original = await fs.readFile(manifestPath, "utf8");
	const normalizedTools = JSON.parse(tools).map((tool: Record<string, unknown>) => ({
		...tool,
		parameters: tool.parameters ?? { type: "object", properties: {} },
	}));
	const next = original
		.replace(/"version": "[^"]+"/, `"version": "${version}"`)
		.replace(/"tools": \[[\s\S]*?\],\n {2}"hooks"/, `"tools": ${JSON.stringify(normalizedTools)},\n  "hooks"`);
	await fs.writeFile(manifestPath, next);
}

async function installFixture(cwd: string, scope: "project" | "user", source = sixSurface): Promise<VibBundleIdentity> {
	const result = await installVibBundle({ cwd }, scope, source);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.code);
	return result.value.summary.identity;
}

async function summary(cwd: string, identity: VibBundleIdentity) {
	const result = await getVibBundle({ cwd }, identity);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.code);
	return result.value;
}

describe("Vibrato bundle lifecycle", () => {
	test("installs a fresh bundle with an enabled, unquarantined six-surface summary", async () => {
		const cwd = await mkProjectCwd();
		const result = await installVibBundle({ cwd }, "project", sixSurface);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error.code);
		expect(result.value.status).toBe("installed");
		expect(result.value.summary.identity).toEqual(bundleIdentity("project", "valid-six-surface-bundle"));
		expect(result.value.summary.surfaces).toHaveLength(6);
		expect(result.value.summary.surfaces.every(surface => surface.enabled)).toBe(true);
		expect(result.value.summary.quarantined).toBe(false);
	});

	test("refuses reinstall without mutating the installed target", async () => {
		const cwd = await mkProjectCwd();
		const identity = await installFixture(cwd, "project");
		const before = await summary(cwd, identity);
		const refused = await installVibBundle({ cwd }, "project", sixSurface);
		expect(refused).toMatchObject({ ok: false, error: { code: "already_installed_use_upgrade" } });
		if (refused.ok) throw new Error("expected install refusal");
		expect(refused.error.recovery).toContain("upgrade");
		expect((await summary(cwd, identity)).targetFingerprint).toBe(before.targetFingerprint);
	});

	test("keeps same-name bundles in separate scopes independent", async () => {
		const cwd = await mkProjectCwd();
		const project = await installFixture(cwd, "project");
		const user = await installFixture(cwd, "user");
		const userBefore = await summary(cwd, user);
		expect((await listVibBundles({ cwd })).map(item => item.identity)).toEqual([user, project]);
		const disabled = await setVibBundleEnabled({ cwd }, project, false);
		expect(disabled).toMatchObject({ ok: true, value: { mutated: true, summary: { enabled: false } } });
		expect(await summary(cwd, user)).toEqual(userBefore);
	});
	test("uninstalls a user bundle and removes its installed root", async () => {
		const cwd = await mkProjectCwd();
		const identity = await installFixture(cwd, "user");
		const registryBefore = await readRegistry("user", cwd);
		const entry = registryBefore.plugins.find(plugin => plugin.name === identity.name);
		expect(entry).toBeDefined();
		if (!entry) throw new Error("missing installed entry");
		expect(await fs.stat(entry.pluginRoot)).toBeTruthy();

		const result = await uninstallVibBundle({ cwd }, identity);
		expect(result).toMatchObject({ ok: true, value: { identity } });
		expect((await readRegistry("user", cwd)).plugins).toHaveLength(0);
		await expect(fs.stat(entry.pluginRoot)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("previews an uninstall without removing the registry entry or the installed root", async () => {
		const cwd = await mkProjectCwd();
		const identity = await installFixture(cwd, "user");
		const registryPath = registryPathForScope("user", cwd);
		const registryBefore = await fs.readFile(registryPath, "utf8");
		const entry = (await readRegistry("user", cwd)).plugins.find(plugin => plugin.name === identity.name);
		if (!entry) throw new Error("missing installed entry");

		const result = await previewVibBundleUninstall({ cwd }, identity);

		expect(result).toMatchObject({ ok: true, value: { status: "would-uninstall", identity } });
		if (!result.ok) throw new Error(result.error.code);
		expect(result.value.summary.identity).toEqual(identity);
		expect(await fs.readFile(registryPath, "utf8")).toBe(registryBefore);
		expect(await fs.stat(entry.pluginRoot)).toBeTruthy();
	});

	// A preview resolves the same target the real uninstall would, so a target
	// that is not installed must fail identically instead of reporting success.
	test("previewing an uninstall of a bundle that is not installed returns not_installed", async () => {
		const cwd = await mkProjectCwd();
		const result = await previewVibBundleUninstall({ cwd }, bundleIdentity("user", "valid-six-surface-bundle"));

		expect(result).toMatchObject({ ok: false, error: { code: "not_installed" } });
	});

	// The preview must see a legacy bundle that exists on disk without a registry
	// entry -- the migrating read the real uninstall uses would discover it -- and
	// must not persist that discovery or take the scope lock.
	test("previews a discoverable legacy bundle without persisting migration or locking", async () => {
		const cwd = await mkProjectCwd();
		const projectRoot = path.join(cwd, ".vib", "vib-plugins", "valid-six-surface-bundle");
		await fs.cp(sixSurface, projectRoot, { recursive: true });
		const registryPath = registryPathForScope("project", cwd);

		const result = await previewVibBundleUninstall({ cwd }, bundleIdentity("project", "valid-six-surface-bundle"));

		expect(result).toMatchObject({ ok: true, value: { status: "would-uninstall" } });
		await expect(fs.stat(registryPath)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(path.join(path.dirname(registryPath), "registry.lock"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(await fs.stat(projectRoot)).toBeTruthy();
	});
	test("returns a typed error for a malformed registry entry without removing its root", async () => {
		const cwd = await mkProjectCwd();
		const identity = await installFixture(cwd, "user");
		const registryPath = registryPathForScope("user", cwd);
		const raw = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
			plugins: Array<Record<string, unknown>>;
		};
		const entry = raw.plugins[0];
		expect(entry).toBeDefined();
		if (!entry) throw new Error("missing installed entry");
		const installedRoot = entry.pluginRoot;
		expect(typeof installedRoot).toBe("string");
		if (typeof installedRoot !== "string") throw new Error("missing installed root");
		const surfaces = entry.surfaces as Record<string, unknown>;
		surfaces.tools = null;
		await fs.writeFile(registryPath, JSON.stringify(raw));

		const result = await uninstallVibBundle({ cwd }, identity);

		expect(result).toMatchObject({
			ok: false,
			error: { code: "invalid_target", recovery: expect.stringContaining("retry") },
		});
		await expect(fs.stat(installedRoot)).resolves.toBeTruthy();
	});
	// Exhaustive result contract for the two exported uninstall entry points.
	// The mutating API must keep its historical `invalid_target` mapping for a
	// malformed registry; only the read-only preview surfaces the internal
	// `registry_unreadable` classification signal the CLI fails closed on.
	test("keeps the mutating and preview uninstall result contracts distinct for a malformed registry", async () => {
		const cwd = await mkProjectCwd();
		const identity = await installFixture(cwd, "user");
		const registryPath = registryPathForScope("user", cwd);
		const healthy = await fs.readFile(registryPath, "utf8");

		// Healthy: preview resolves the exact target; a repeated real uninstall is not_installed.
		const previewOk = await previewVibBundleUninstall({ cwd }, identity);
		expect(previewOk).toMatchObject({ ok: true, value: { status: "would-uninstall", identity } });
		await expect(fs.stat(registryPath)).resolves.toBeTruthy();

		// Malformed registry: mutating keeps invalid_target, preview reports registry_unreadable.
		await fs.writeFile(registryPath, "{ corrupt");
		const mut = await uninstallVibBundle({ cwd }, identity);
		expect(mut).toMatchObject({ ok: false, error: { code: "invalid_target" } });
		const prev = await previewVibBundleUninstall({ cwd }, identity);
		expect(prev).toMatchObject({ ok: false, error: { code: "registry_unreadable" } });

		// Restored registry: the real uninstall still removes the bundle.
		await fs.writeFile(registryPath, healthy);
		const removed = await uninstallVibBundle({ cwd }, identity);
		expect(removed).toMatchObject({ ok: true, value: { identity } });
		const gone = await uninstallVibBundle({ cwd }, identity);
		expect(gone).toMatchObject({ ok: false, error: { code: "not_installed" } });
	});

	test("keeps non-uninstallable metadata failures aligned between preview and mutating uninstall", async () => {
		const cwd = await mkProjectCwd();
		const identity = await installFixture(cwd, "user");
		const registryPath = registryPathForScope("user", cwd);
		const raw = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
			plugins: Array<Record<string, unknown>>;
		};
		delete raw.plugins[0].version;
		await fs.writeFile(registryPath, JSON.stringify(raw));

		const prev = await previewVibBundleUninstall({ cwd }, identity);
		expect(prev).toMatchObject({ ok: false, error: { code: "invalid_target" } });
		const mut = await uninstallVibBundle({ cwd }, identity);
		expect(mut).toMatchObject({ ok: false, error: { code: "invalid_target" } });
	});

	test("restores the root and returns a typed error when registry removal fails", async () => {
		const cwd = await mkProjectCwd();
		const identity = await installFixture(cwd, "user");
		const registryBefore = await readRegistry("user", cwd);
		const entry = registryBefore.plugins.find(plugin => plugin.name === identity.name);
		expect(entry).toBeDefined();
		if (!entry) throw new Error("missing installed entry");

		const realRename = fs.rename;
		const renameSpy = spyOn(fs, "rename");
		renameSpy.mockImplementationOnce(realRename);
		renameSpy.mockRejectedValueOnce(new Error("registry rename failed"));
		renameSpy.mockImplementation(realRename);

		const result = await uninstallVibBundle({ cwd }, identity);

		renameSpy.mockRestore();
		expect(result).toMatchObject({
			ok: false,
			error: { code: "invalid_target", recovery: expect.stringContaining("retry") },
		});
		expect((await readRegistry("user", cwd)).plugins).toHaveLength(1);
		await expect(fs.stat(entry.pluginRoot)).resolves.toBeTruthy();
	});

	// A registry whose `pluginRoot` points outside the scope root is the shape a
	// tampered or hand-edited registry takes; uninstall must refuse it instead of
	// deleting whatever the path names.
	test("refuses to remove a registry root that escapes the scope directory", async () => {
		const cwd = await mkProjectCwd();
		const identity = await installFixture(cwd, "user");
		const outside = await mkProjectCwd();
		const sentinel = path.join(outside, "keep-me.txt");
		await fs.writeFile(sentinel, "not yours to delete");

		const registryPath = registryPathForScope("user", cwd);
		const raw = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
			plugins: Array<Record<string, unknown>>;
		};
		const entry = raw.plugins[0];
		expect(entry).toBeDefined();
		if (!entry) throw new Error("missing installed entry");
		entry.pluginRoot = outside;
		await fs.writeFile(registryPath, JSON.stringify(raw));

		const result = await uninstallVibBundle({ cwd }, identity);

		expect(result).toMatchObject({ ok: false, error: { code: "invalid_target" } });
		await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("not yours to delete");
		expect((await readRegistry("user", cwd, { migrate: false })).plugins).toHaveLength(1);
	});

	test("installs the same bundle again after an uninstall", async () => {
		const cwd = await mkProjectCwd();
		const identity = await installFixture(cwd, "user");
		expect(await uninstallVibBundle({ cwd }, identity)).toMatchObject({ ok: true });

		const reinstalled = await installVibBundle({ cwd }, "user", sixSurface);

		expect(reinstalled.ok).toBe(true);
		if (!reinstalled.ok) throw new Error(reinstalled.error.code);
		expect(reinstalled.value.summary.identity).toEqual(identity);
		const registry = await readRegistry("user", cwd);
		expect(registry.plugins).toHaveLength(1);
		await expect(fs.stat(registry.plugins[0].pluginRoot)).resolves.toBeTruthy();
	});

	test("previews unchanged source with an identity-bound unchanged token", async () => {
		const cwd = await mkProjectCwd();
		const identity = await installFixture(cwd, "project");
		const preview = await previewVibBundleUpdate({ cwd }, identity);
		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.error.code);
		expect(preview.value).toMatchObject({ identity, changed: false, addedSurfaceIds: [], removedSurfaceIds: [] });
		expect(preview.value.token.identity).toEqual(identity);
	});

	test("previews and applies changed source content with surface deltas", async () => {
		const cwd = await mkProjectCwd();
		const source = await mkSource();
		const identity = await installFixture(cwd, "project", source);
		const previous = await summary(cwd, identity);
		await fs.writeFile(path.join(source, "tools", "additional.ts"), "export const additional = true;\n");
		await rewriteManifest(
			source,
			"1.1.0",
			'[{ "name": "additional", "path": "tools/additional.ts", "description": "Additional tool" }]',
		);
		const preview = await previewVibBundleUpdate({ cwd }, identity);
		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.error.code);
		expect(preview.value.changed).toBe(true);
		expect(preview.value.addedSurfaceIds).toHaveLength(1);
		expect(preview.value.removedSurfaceIds).toHaveLength(1);
		const applied = await applyVibBundleUpdate({ cwd }, preview.value.token);
		expect(applied).toMatchObject({ ok: true, value: { status: "updated" } });
		const updated = await summary(cwd, identity);
		expect(updated.version).toBe(preview.value.candidateVersion);
		expect(updated.manifestHash).toBe(preview.value.candidateManifestHash);
		expect(updated.targetFingerprint).not.toBe(previous.targetFingerprint);
	});

	test("rejects a candidate that changed after preview without mutation", async () => {
		const cwd = await mkProjectCwd();
		const source = await mkSource();
		const identity = await installFixture(cwd, "project", source);
		const preview = await previewVibBundleUpdate({ cwd }, identity);
		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.error.code);
		const before = await summary(cwd, identity);
		await fs.appendFile(path.join(source, "prompts", "system-appendix.md"), "changed after review\n");
		const applied = await applyVibBundleUpdate({ cwd }, preview.value.token);
		expect(applied).toMatchObject({ ok: false, error: { code: "stale_candidate" } });
		expect((await summary(cwd, identity)).targetFingerprint).toBe(before.targetFingerprint);
	});

	test("rejects a preview when a bundle toggle changes the installed baseline", async () => {
		const cwd = await mkProjectCwd();
		const identity = await installFixture(cwd, "project");
		const preview = await previewVibBundleUpdate({ cwd }, identity);
		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.error.code);
		const before = await summary(cwd, identity);
		expect(await setVibBundleEnabled({ cwd }, identity, false)).toMatchObject({ ok: true, value: { mutated: true } });
		const applied = await applyVibBundleUpdate({ cwd }, preview.value.token);
		expect(applied).toMatchObject({ ok: false, error: { code: "stale_baseline" } });
		// targetFingerprint covers installed content only; enablement intent is a
		// separate axis, so a toggle leaves the content fingerprint untouched while
		// still invalidating the reviewed baseline.
		const after = await summary(cwd, identity);
		expect(after.targetFingerprint).toBe(before.targetFingerprint);
		expect(after.enabled).toBe(false);
		expect(before.enabled).toBe(true);
	});
	test("rejects a preview when a surface toggle changes the installed baseline", async () => {
		const cwd = await mkProjectCwd();
		const identity = await installFixture(cwd, "project");
		const preview = await previewVibBundleUpdate({ cwd }, identity);
		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.error.code);
		const surfaceId = (await summary(cwd, identity)).surfaces[0]?.extensionId;
		expect(surfaceId).toBeDefined();
		if (!surfaceId) throw new Error("missing surface");
		expect(await setVibBundleSurfaceEnabled({ cwd }, identity, surfaceId, false)).toMatchObject({
			ok: true,
			value: { mutated: true },
		});
		expect(await applyVibBundleUpdate({ cwd }, preview.value.token)).toMatchObject({
			ok: false,
			error: { code: "stale_baseline" },
		});
	});

	test("carries surviving disabled surfaces through updates and drops removed IDs", async () => {
		const cwd = await mkProjectCwd();
		const source = await mkSource();
		const identity = await installFixture(cwd, "project", source);
		const original = await summary(cwd, identity);
		const domainNote = original.surfaces.find(surface => surface.name === "domain_note");
		expect(domainNote).toBeDefined();
		if (!domainNote) throw new Error("missing domain_note surface");
		expect(await setVibBundleSurfaceEnabled({ cwd }, identity, domainNote.extensionId, false)).toMatchObject({
			ok: true,
			value: { mutated: true },
		});
		await fs.writeFile(path.join(source, "tools", "additional.ts"), "export const additional = true;\n");
		await rewriteManifest(
			source,
			"1.1.0",
			'[{ "name": "domain_note", "path": "tools/domain-note.ts", "description": "Write a domain-scoped note" }, { "name": "additional", "path": "tools/additional.ts", "description": "Additional tool" }]',
		);
		const first = await previewVibBundleUpdate({ cwd }, identity);
		expect(first.ok).toBe(true);
		if (!first.ok) throw new Error(first.error.code);
		expect(await applyVibBundleUpdate({ cwd }, first.value.token)).toMatchObject({
			ok: true,
			value: { status: "updated" },
		});
		const withAdditional = await summary(cwd, identity);
		expect(withAdditional.surfaces.find(surface => surface.extensionId === domainNote.extensionId)?.enabled).toBe(
			false,
		);
		const additional = withAdditional.surfaces.find(surface => surface.name === "additional");
		expect(additional?.enabled).toBe(true);
		await rewriteManifest(
			source,
			"1.2.0",
			'[{ "name": "additional", "path": "tools/additional.ts", "description": "Additional tool" }]',
		);
		const second = await previewVibBundleUpdate({ cwd }, identity);
		expect(second.ok).toBe(true);
		if (!second.ok) throw new Error(second.error.code);
		expect(await applyVibBundleUpdate({ cwd }, second.value.token)).toMatchObject({
			ok: true,
			value: { status: "updated" },
		});
		expect(
			(await summary(cwd, identity)).surfaces.find(surface => surface.extensionId === domainNote.extensionId),
		).toBeUndefined();
	});

	test("makes repeated bundle and surface toggle requests no-ops and rejects unknown surfaces", async () => {
		const cwd = await mkProjectCwd();
		const identity = await installFixture(cwd, "project");
		const before = JSON.stringify(await readRegistry("project", cwd));
		expect(await setVibBundleEnabled({ cwd }, identity, true)).toMatchObject({ ok: true, value: { mutated: false } });
		expect(JSON.stringify(await readRegistry("project", cwd))).toBe(before);
		expect(await setVibBundleSurfaceEnabled({ cwd }, identity, "missing-surface", false)).toMatchObject({
			ok: false,
			error: { code: "surface_unknown" },
		});
		const surfaceId = (await summary(cwd, identity)).surfaces[0]?.extensionId;
		expect(surfaceId).toBeDefined();
		if (!surfaceId) throw new Error("missing surface");
		expect(await setVibBundleSurfaceEnabled({ cwd }, identity, surfaceId, true)).toMatchObject({
			ok: true,
			value: { mutated: false },
		});
		expect(JSON.stringify(await readRegistry("project", cwd))).toBe(before);
	});

	test("reports exact-scope missing bundles and redacts source locators", async () => {
		const cwd = await mkProjectCwd();
		const userIdentity = await installFixture(cwd, "user");
		const projectIdentity = bundleIdentity("project", userIdentity.name);
		expect(await getVibBundle({ cwd }, projectIdentity)).toMatchObject({
			ok: false,
			error: { code: "not_installed" },
		});
		expect(await previewVibBundleUpdate({ cwd }, projectIdentity)).toMatchObject({
			ok: false,
			error: { code: "not_installed" },
		});
		const redacted = redactSourceLocator({
			kind: "git",
			uri: "https://user:token@example.com/owner/repo.git?x=1#frag",
			resolvedAt: "now",
		});
		expect(redacted).toContain("example.com/owner/repo");
		expect(redacted).not.toContain("token");
		expect(redacted).not.toContain("user:");
		expect(redacted).not.toContain("?x=1");
		expect(redacted).not.toContain("#frag");
	});
});
