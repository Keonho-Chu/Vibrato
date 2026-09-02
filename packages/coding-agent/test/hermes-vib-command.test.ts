import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { runSetupCommand } from "../src/cli/setup-cli";
import Setup from "../src/commands/setup";
import { buildHermesSetupSpec, computeHermesSetupSignature, runHermesSetup } from "../src/setup/hermes-setup";

let tempRoot: string | undefined;

const BASE_FLAGS = { json: true, root: [""] } as const;

function renderPreviewFlags(vibCommand: string, root: string): Parameters<typeof runHermesSetup>[0] {
	return { json: true, root: [root], profile: "test", repo: "repo", vibCommand };
}

function parseServerBlock(content: string): { command: string; args: string[] } {
	const parsed = YAML.parse(content) as {
		mcp_servers: Record<string, { command: string; args?: string[] }>;
	};
	const server = parsed.mcp_servers.vib_coordinator;
	if (!server) throw new Error("missing vib_coordinator block");
	return { command: server.command, args: server.args ?? [] };
}

async function renderServer(vibCommand: string, root: string): Promise<{ command: string; args: string[] }> {
	const result = await runHermesSetup(renderPreviewFlags(vibCommand, root));
	const configPreview = result.previews.find(preview => preview.path.endsWith(".yaml"))?.content ?? "";
	return parseServerBlock(configPreview);
}

describe("vib setup hermes --vib-command", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		if (tempRoot) {
			await fs.rm(tempRoot, { recursive: true, force: true });
			tempRoot = undefined;
		}
	});

	it("renders the historical default launch argv byte-compatibly", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vib-vib-command-"));
		const server = await renderServer("vib", tempRoot);
		expect(server).toEqual({ command: "vib", args: ["mcp-serve", "coordinator"] });
	});

	it("keeps an omitted --vib-command on the default executable", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vib-vib-command-"));
		const result = await runHermesSetup({ json: true, root: [tempRoot], profile: "test", repo: "repo" });
		const server = parseServerBlock(result.previews.find(preview => preview.path.endsWith(".yaml"))?.content ?? "");
		expect(server).toEqual({ command: "vib", args: ["mcp-serve", "coordinator"] });
	});

	it("keeps a single-token custom executable without wrapper args", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vib-vib-command-"));
		expect(await renderServer("/opt/vib", tempRoot)).toEqual({
			command: "/opt/vib",
			args: ["mcp-serve", "coordinator"],
		});
	});

	it("renders a multi-token wrapper verbatim as the full server command", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vib-vib-command-"));
		// The issue's repro: a wrapper that already execs `vib mcp-serve
		// coordinator` must not receive a doubled argv tail.
		expect(await renderServer("python3 /tmp/vib-wrapper.py", tempRoot)).toEqual({
			command: "python3",
			args: ["/tmp/vib-wrapper.py"],
		});
		expect(await renderServer("env WRAPPER=1 vib mcp-serve coordinator", tempRoot)).toEqual({
			command: "env",
			args: ["WRAPPER=1", "vib", "mcp-serve", "coordinator"],
		});
		expect(await renderServer("mise exec -- vib mcp-serve coordinator", tempRoot)).toEqual({
			command: "mise",
			args: ["exec", "--", "vib", "mcp-serve", "coordinator"],
		});
	});

	it("honors quoting and escapes when splitting wrapper argv", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vib-vib-command-"));
		expect(await renderServer('"/opt/my tools/vib" --proxy unix:///run/x.sock', tempRoot)).toEqual({
			command: "/opt/my tools/vib",
			args: ["--proxy", "unix:///run/x.sock"],
		});
		expect(await renderServer("python3 'it\\'s.py'", tempRoot)).toEqual({
			command: "python3",
			args: ["it's.py"],
		});
		expect(await renderServer('python3 "a\\ b.py"', tempRoot)).toEqual({
			command: "python3",
			args: ["a b.py"],
		});
	});

	it("rejects unbalanced quotes and an empty executable", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vib-vib-command-"));
		await expect(renderServer('env "WRAPPER vib', tempRoot)).rejects.toThrow("unbalanced quote");
		await expect(renderServer("python3 'wrapper.py", tempRoot)).rejects.toThrow("unbalanced quote");
		await expect(renderServer("''", tempRoot)).rejects.toThrow("non-empty executable");
		await expect(renderServer("'' --flag", tempRoot)).rejects.toThrow("non-empty executable");
	});

	it("keeps the signature deterministic for the same effective launch argv", () => {
		const specExplicit = buildHermesSetupSpec({ ...BASE_FLAGS, root: [tempRoot ?? "."], vibCommand: "vib" });
		const specDefault = buildHermesSetupSpec({ ...BASE_FLAGS, root: [tempRoot ?? "."] });
		expect(computeHermesSetupSignature(specExplicit)).toBe(computeHermesSetupSignature(specDefault));

		const specSinglePath = buildHermesSetupSpec({
			...BASE_FLAGS,
			root: [tempRoot ?? "."],
			vibCommand: "/opt/vib",
		});
		expect(specSinglePath.args).toEqual(["mcp-serve", "coordinator"]);
	});

	it("installs wrapper launch argv and keeps installs idempotent through check", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vib-vib-command-"));
		const profileDir = path.join(tempRoot, "profile");
		const configPath = path.join(profileDir, "config.yaml");

		const first = await runHermesSetup({
			json: true,
			install: true,
			root: [tempRoot],
			profileDir,
			vibCommand: "python3 /tmp/vib-wrapper.py",
		});
		expect(first.files_written).toContain(configPath);
		expect(parseServerBlock(await Bun.file(configPath).text())).toEqual({
			command: "python3",
			args: ["/tmp/vib-wrapper.py"],
		});

		const again = await runHermesSetup({
			json: true,
			install: true,
			root: [tempRoot],
			profileDir,
			vibCommand: "python3 /tmp/vib-wrapper.py",
		});
		expect(again.files_written).toContain(configPath);
		expect(parseServerBlock(await Bun.file(configPath).text())).toEqual({
			command: "python3",
			args: ["/tmp/vib-wrapper.py"],
		});

		const check = await runHermesSetup({
			json: true,
			check: true,
			root: [tempRoot],
			profileDir,
			vibCommand: "python3 /tmp/vib-wrapper.py",
		});
		expect(check.ok).toBe(true);
		expect(check.check?.mismatches).toEqual([]);

		const checkQuoted = await runHermesSetup({
			json: true,
			check: true,
			root: [tempRoot],
			profileDir,
			vibCommand: "python3 '/tmp/vib-wrapper.py'",
		});
		expect(checkQuoted.ok).toBe(true);
		expect(checkQuoted.check?.mismatches).toEqual([]);
	});

	it("routes a wrapper --vib-command through the shared setup CLI dispatch", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vib-vib-command-"));
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runSetupCommand({
			component: "hermes",
			flags: { json: true, root: [tempRoot], vibCommand: "python3 /tmp/vib-wrapper.py" },
		});

		const output = stdout.mock.calls.map(call => String(call[0])).join("");
		const parsed = JSON.parse(output) as { previews: Array<{ path: string; content: string }> };
		const configPreview = parsed.previews.find(preview => preview.path.endsWith(".yaml"))?.content ?? "";
		expect(parseServerBlock(configPreview)).toEqual({
			command: "python3",
			args: ["/tmp/vib-wrapper.py"],
		});
	});

	it("keeps the Oclif --vib-command help aligned with the full-command contract", () => {
		expect(Setup.flags["vib-command"].description).toContain("complete server command rendered verbatim");
		expect(Setup.flags["vib-command"].description).toContain("never shell-evaluated");
	});
});
