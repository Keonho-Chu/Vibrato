import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const expectedWorkflowSkills = ["autoresearch", "deep-interview", "ralplan", "ultragoal"];

describe("Vibrato dogfood skill template", () => {
	it("documents local override installation without changing the default workflow surface", async () => {
		const template = await Bun.file(path.join(repoRoot, "docs", "vib-dogfood-skill-template.md")).text();
		const defaultSkillsDir = path.join(repoRoot, "packages", "coding-agent", "src", "defaults", "vib", "skills");
		const defaultSkillEntries = await Array.fromAsync(new Bun.Glob("*/SKILL.md").scan(defaultSkillsDir));
		const defaultSkillNames = defaultSkillEntries.map(entry => entry.split("/")[0]).sort();

		expect(defaultSkillNames).toEqual(expectedWorkflowSkills);
		// Install path must target the scanned user-level location, frontmatter-first.
		expect(template).toContain("mkdir -p ~/.vib/agent/skills/vib-dogfood");
		expect(template).toContain(
			"sed -n '/^---$/,$p' docs/vib-dogfood-skill-template.md > ~/.vib/agent/skills/vib-dogfood/SKILL.md",
		);
		expect(template).toContain(
			"Install into the user-level scan location (`~/.vib/agent/skills/`, not `~/.vib/skills/`):",
		);
		expect(template).toContain("<project>/.vib/skills/vib-dogfood/SKILL.md");
		expect(template).toContain("The live issue has no comment approving a fifth bundled default workflow skill");
		expect(template).toContain("Use when running or reviewing work through Vibrato sessions");
		expect(template).toContain("vib --tmux --worktree <branch-like-name>");
		expect(template).toContain("Do not pass filesystem paths to `--worktree`");
		expect(template).toContain("vib-rato-93-dogfood-skill");
		expect(template).toContain("Verify the prompt was accepted");
		expect(template).toContain("create or link the vib-rato issue");
	});

	it("keeps the installable body frontmatter-first so the skill scan accepts it", async () => {
		const template = await Bun.file(path.join(repoRoot, "docs", "vib-dogfood-skill-template.md")).text();
		const lines = template.split("\n");
		const markerIndex = lines.indexOf("---");
		expect(markerIndex).toBeGreaterThan(0);
		// The extracted artifact starts at the marker; name/description must follow immediately.
		expect(lines[markerIndex + 1]).toBe("name: vib-dogfood");
		expect(lines[markerIndex + 2]?.startsWith("description: ")).toBe(true);
		const closingIndex = lines.indexOf("---", markerIndex + 1);
		expect(closingIndex).toBeGreaterThan(markerIndex);
	});
});
