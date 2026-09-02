/**
 * Generated bundled Vibrato workflow skill catalog.
 *
 * Keep this module metadata-only: skill bodies are loaded through literal
 * dynamic imports only when a caller asks for their content.
 */
export type BundledVibSkillName = "autoresearch" | "deep-interview" | "ralplan" | "ultragoal";

export interface BundledVibSkillCatalogEntry {
	readonly kind: "skill" | "skill-fragment";
	readonly name?: BundledVibSkillName;
	readonly parentSkillName?: BundledVibSkillName;
	readonly relativePath: string;
	readonly description?: string;
	readonly loadContent: () => Promise<string>;
}

const deepInterview = () =>
	import("./vib/skills/deep-interview/SKILL.md", { with: { type: "text" } }).then(module => module.default);
const ralplan = () =>
	import("./vib/skills/ralplan/SKILL.md", { with: { type: "text" } }).then(module => module.default);
const autoresearch = () =>
	import("./vib/skills/autoresearch/SKILL.md", { with: { type: "text" } }).then(module => module.default);
const ultragoal = () =>
	import("./vib/skills/ultragoal/SKILL.md", { with: { type: "text" } }).then(module => module.default);
const autoAnswerUncertain = () =>
	import("./vib/skills/deep-interview/auto-answer-uncertain.md", { with: { type: "text" } }).then(
		module => module.default,
	);
const lateralReviewPanel = () =>
	import("./vib/skills/deep-interview/lateral-review-panel.md", { with: { type: "text" } }).then(
		module => module.default,
	);
const aiSlopCleaner = () =>
	import("./vib/skills/ultragoal/ai-slop-cleaner.md", { with: { type: "text" } }).then(module => module.default);
const validationBatchContracts = () =>
	import("./vib/skills/ultragoal/validation-batch-contracts.md", { with: { type: "text" } }).then(
		module => module.default,
	);
const autoresearchIterate = () =>
	import("./vib/skills/autoresearch/auto-iterate.md", { with: { type: "text" } }).then(module => module.default);
const autoresearchCritic = () =>
	import("./vib/skills/autoresearch/auto-critic.md", { with: { type: "text" } }).then(module => module.default);

export const BUNDLED_VIB_SKILL_CATALOG: readonly BundledVibSkillCatalogEntry[] = [
	{
		kind: "skill",
		name: "deep-interview",
		relativePath: "skills/deep-interview/SKILL.md",
		description: "Socratic deep interview with mathematical ambiguity gating before explicit execution approval",
		loadContent: deepInterview,
	},
	{
		kind: "skill",
		name: "ralplan",
		relativePath: "skills/ralplan/SKILL.md",
		description: "Consensus planning entrypoint that auto-gates vague ultragoal requests before execution",
		loadContent: ralplan,
	},
	{
		kind: "skill",
		name: "autoresearch",
		relativePath: "skills/autoresearch/SKILL.md",
		description: "Goal-directed research missions interleaving web and data evidence into a structured verdict",
		loadContent: autoresearch,
	},
	{
		kind: "skill",
		name: "ultragoal",
		relativePath: "skills/ultragoal/SKILL.md",
		description: "Create and execute durable repo-native multi-goal plans over Vibrato goal mode artifacts.",
		loadContent: ultragoal,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "deep-interview",
		relativePath: "skill-fragments/deep-interview/auto-answer-uncertain.md",
		loadContent: autoAnswerUncertain,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "deep-interview",
		relativePath: "skill-fragments/deep-interview/lateral-review-panel.md",
		loadContent: lateralReviewPanel,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "ultragoal",
		relativePath: "skill-fragments/ultragoal/ai-slop-cleaner.md",
		loadContent: aiSlopCleaner,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "ultragoal",
		relativePath: "skill-fragments/ultragoal/validation-batch-contracts.md",
		loadContent: validationBatchContracts,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "autoresearch",
		relativePath: "skill-fragments/autoresearch/auto-iterate.md",
		loadContent: autoresearchIterate,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "autoresearch",
		relativePath: "skill-fragments/autoresearch/auto-critic.md",
		loadContent: autoresearchCritic,
	},
];
