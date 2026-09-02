import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@vib-rato/agent-core";
import { getWorkflowMutationDecision } from "../../src/skill-state/workflow-mutation-guard";

async function withTempCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vib-acl-gate-"));
	const priorSessionId = process.env.VIB_SESSION_ID;
	process.env.VIB_SESSION_ID = "test-session";
	try {
		await fn(dir);
	} finally {
		if (priorSessionId !== undefined) process.env.VIB_SESSION_ID = priorSessionId;
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function tool(name: string, extra: Record<string, unknown> = {}): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: {} as never,
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		...extra,
	} as AgentTool;
}

describe("G2 vib ACL gate", () => {
	it("blocks mutation tools targeting .vib paths", async () => {
		await withTempCwd(async cwd => {
			const blockedCases: Array<[AgentTool, unknown]> = [
				[tool("write"), { path: ".vib/state/foo.json", content: "{}" }],
				[tool("edit"), { path: ".vib/specs/spec.md", edits: [{ old_text: "a", new_text: "b" }] }],
				[tool("ast_edit"), { paths: [".vib/state/foo.json"], ops: [{ pat: "foo", out: "bar" }] }],
			];

			for (const [targetTool, args] of blockedCases) {
				const decision = await getWorkflowMutationDecision({ cwd, tool: targetTool, args });
				expect(decision.blocked).toBe(true);
				expect(decision.message).toContain("runtime-owned");
				if (decision.reason !== "unknown-target") {
					expect(["vib-target", "workflow-state-target"]).toContain(decision.reason as string);
				}
			}
		});
	});

	it("allows sanctioned vib bash commands, bash mutations, and non-.vib writes", async () => {
		await withTempCwd(async cwd => {
			const vibCommand = await getWorkflowMutationDecision({
				cwd,
				tool: tool("bash"),
				args: { command: "vib state ralplan write --input '{}'" },
			});
			expect(vibCommand.blocked).toBe(false);

			const bashMutation = await getWorkflowMutationDecision({
				cwd,
				tool: tool("bash"),
				args: { command: "rm -rf .vib/specs" },
			});
			expect(bashMutation.blocked).toBe(false);

			const productWrite = await getWorkflowMutationDecision({
				cwd,
				tool: tool("write"),
				args: { path: "src/product.ts", content: "x" },
			});
			expect(productWrite.blocked).toBe(false);

			// Per #951 the mutation guard never blocks `bash`; `.vib/**` is gated only
			// through the dedicated write/edit/ast_edit tools, so bash targeting .vib is allowed.
			for (const command of ["echo x > .vib/state/foo.json", "rm -rf .vib/specs"]) {
				const vibBash = await getWorkflowMutationDecision({ cwd, tool: tool("bash"), args: { command } });
				expect(vibBash.blocked).toBe(false);
			}
		});
	});
});
