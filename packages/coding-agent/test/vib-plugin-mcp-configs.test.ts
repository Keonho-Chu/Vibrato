import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@vib-rato/utils";
import { buildPluginMcpConfigs, installVibBundle } from "../src/extensibility/vib-plugins";
import { isPluginMcpPublicNetworkBound } from "../src/runtime-mcp/plugin-network-boundary";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "vib-plugins");
const sixSurface = path.join(fixturesRoot, "valid-six-surface-bundle");
const tempDirs: string[] = [];
const originalAgentDir = getAgentDir();
let agentDir: string;

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "vib-mcp-configs-agent-"));
	setAgentDir(agentDir);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	for (const d of tempDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
	await fs.rm(agentDir, { recursive: true, force: true });
});

describe("plugin MCP runtime config conversion", () => {
	test("converts a bundled stdio MCP into a root-confined runtime config", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "vib-mcp-"));
		tempDirs.push(cwd);
		const r = await installVibBundle({ cwd }, "project", sixSurface);
		expect(r.ok).toBe(true);
		const { configs, quarantine } = await buildPluginMcpConfigs({ cwd });
		expect(quarantine).toHaveLength(0);
		const docs = configs.domain_docs;
		expect(docs.type).toBe("stdio");
		expect(docs.command).toBe("bun");
		expect(docs.args).toEqual(["mcp/domain-docs.ts"]);
		// cwd is confined to the installed plugin root.
		const installedRoot = path.join(cwd, ".vib", "vib-plugins", "valid-six-surface-bundle");
		expect(path.resolve(docs.cwd)).toBe(path.resolve(installedRoot));
	});

	test("empty when no plugins installed", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "vib-mcp-empty-"));
		tempDirs.push(cwd);
		const { configs } = await buildPluginMcpConfigs({ cwd });
		expect(configs).toEqual({});
	});

	test("binds bundled remote MCP configs to the public-network transport", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "vib-mcp-remote-"));
		const bundle = await fs.mkdtemp(path.join(os.tmpdir(), "vib-mcp-remote-bundle-"));
		tempDirs.push(cwd, bundle);
		const url = "https://8.8.8.8/mcp";
		await fs.writeFile(
			path.join(bundle, "vibrato-plugin.json"),
			JSON.stringify({
				kind: "vib-rato-plugin",
				name: "remote-mcp-bundle",
				version: "1.0.0",
				mcps: [{ name: "remote_docs", transport: "http", url }],
			}),
		);

		const r = await installVibBundle({ cwd }, "project", bundle);
		expect(r.ok).toBe(true);
		const { configs, quarantine } = await buildPluginMcpConfigs({ cwd });

		expect(quarantine).toHaveLength(0);
		expect(configs.remote_docs).toMatchObject({ type: "http", url });
		expect(isPluginMcpPublicNetworkBound(configs.remote_docs)).toBe(true);
		expect(isPluginMcpPublicNetworkBound({ ...configs.remote_docs })).toBe(true);
	});
});
