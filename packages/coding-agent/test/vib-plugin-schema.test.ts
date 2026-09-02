import { describe, expect, test } from "bun:test";
import {
	parseManifest,
	parseSubskillFrontmatter,
	VibPluginLoadError,
	type VibPluginLoadErrorCode,
} from "../src/extensibility/vib-plugins";

function expectLoadError(fn: () => unknown, code: VibPluginLoadErrorCode): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(VibPluginLoadError);
		expect((error as VibPluginLoadError).code).toBe(code);
		return;
	}
	throw new Error(`Expected ${code} load error`);
}

describe("Vibrato plugin schema", () => {
	test("parseManifest rejects forbidden extension surfaces", () => {
		for (const key of ["skills", "slash-commands", "commands", "agents"]) {
			expectLoadError(
				() =>
					parseManifest(
						{
							kind: "vib-rato-plugin",
							name: "forbidden",
							version: "1.0.0",
							subskills: [],
							tools: [],
							[key]: [],
						},
						`/plugin/${key}/vibrato-plugin.json`,
					),
				"forbidden_surface",
			);
		}
	});

	test("parseManifest rejects the ambiguous singular mcp alias with an actionable diagnostic", () => {
		expectLoadError(
			() =>
				parseManifest(
					{
						kind: "vib-rato-plugin",
						name: "aliased",
						version: "1.0.0",
						mcp: [],
					},
					"/plugin/mcp/vibrato-plugin.json",
				),
			"unsupported_surface",
		);
	});

	test("parseManifest normalizes the mcpServers alias into canonical mcps entries", () => {
		const manifest = parseManifest(
			{
				kind: "vib-rato-plugin",
				name: "aliased",
				version: "1.0.0",
				mcpServers: {
					docs: { type: "stdio", command: "bun", args: ["mcp/server.ts"], cwd: "." },
					remote: { url: "https://example.com/mcp" },
				},
			},
			"/plugin/mcpServers/vibrato-plugin.json",
		);
		expect(manifest.mcps).toEqual([
			{
				name: "docs",
				transport: "stdio",
				command: "bun",
				args: ["mcp/server.ts"],
				cwd: ".",
				headers: undefined,
				sha256: undefined,
				url: undefined,
			},
			{
				name: "remote",
				transport: "http",
				url: "https://example.com/mcp",
				headers: undefined,
				command: undefined,
				args: undefined,
				cwd: undefined,
				sha256: undefined,
			},
		]);
	});

	test("parseManifest rejects combining mcps with the mcpServers alias", () => {
		expectLoadError(
			() =>
				parseManifest(
					{
						kind: "vib-rato-plugin",
						name: "both",
						version: "1.0.0",
						mcps: [],
						mcpServers: {},
					},
					"/plugin/both/vibrato-plugin.json",
				),
			"invalid_manifest",
		);
	});

	test("parseManifest accepts the six additive surfaces", () => {
		const manifest = parseManifest(
			{
				kind: "vib-rato-plugin",
				name: "six",
				version: "1.0.0",
				subskills: ["subskills/design/SKILL.md"],
				tools: [{ name: "domain_note", path: "tools/domain-note.ts" }],
				hooks: [{ name: "audit", event: "tool_call", target: "read", phase: "before", path: "hooks/a.ts" }],
				mcps: [{ name: "docs", transport: "stdio", command: "bun", args: ["mcp/s.ts"] }],
				system_appendix: [{ name: "policy", path: "prompts/sa.md" }],
				"agent-appendix": [{ agent: "executor", name: "guide", path: "prompts/ea.md" }],
			},
			"/plugin/vibrato-plugin.json",
		);
		expect(manifest.tools[0]).toMatchObject({
			name: "domain_note",
			path: "tools/domain-note.ts",
			surface: "always-on",
		});
		expect(manifest.hooks[0]?.event).toBe("tool_call");
		expect(manifest.mcps[0]?.transport).toBe("stdio");
		expect(manifest.systemAppendix[0]?.name).toBe("policy");
		expect(manifest.agentAppendix[0]?.agent).toBe("executor");
	});

	test("parseManifest accepts absent subskills/tools as empty", () => {
		const manifest = parseManifest(
			{ kind: "vib-rato-plugin", name: "empty", version: "1.0.0" },
			"/plugin/vibrato-plugin.json",
		);
		expect(manifest.subskills).toEqual([]);
		expect(manifest.tools).toEqual([]);
		expect(manifest.hooks).toEqual([]);
	});

	test("parseManifest normalizes legacy string tool shorthand", () => {
		const manifest = parseManifest(
			{ kind: "vib-rato-plugin", name: "legacy", version: "1.0.0", tools: ["tools/domain-note.ts"] },
			"/plugin/vibrato-plugin.json",
		);
		expect(manifest.tools[0]).toMatchObject({
			name: "domain-note",
			path: "tools/domain-note.ts",
			surface: "subskill",
		});
	});

	test("parseManifest rejects malformed known fields", () => {
		expectLoadError(
			() =>
				parseManifest(
					{ kind: "vib-rato-plugin", name: "bad", version: "1.0.0", hooks: {} },
					"/plugin/vibrato-plugin.json",
				),
			"invalid_manifest",
		);
	});

	test("parseManifest rejects invalid kind", () => {
		expectLoadError(
			() =>
				parseManifest(
					{ kind: "claude-plugin", name: "wrong", version: "1.0.0", subskills: [], tools: [] },
					"/plugin/vibrato-plugin.json",
				),
			"invalid_kind",
		);
	});

	test("parseSubskillFrontmatter rejects missing required fields", () => {
		const valid = {
			name: "design",
			binds_to: "ralplan",
			phase: "planner",
			activation_arg: "design",
			description: "Design guidance",
		};

		for (const field of Object.keys(valid)) {
			const fm = { ...valid } as Record<string, unknown>;
			delete fm[field];
			expectLoadError(
				() => parseSubskillFrontmatter(fm, `/plugin/subskills/${field}/SKILL.md`),
				"invalid_frontmatter",
			);
		}
	});
});
