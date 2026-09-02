import { CANONICAL_VIB_WORKFLOW_SKILLS, type CanonicalVibWorkflowSkill } from "../skill-state/active-state";

export interface SkillKeywordDefinition {
	keyword: string;
	skill: VibWorkflowSkill;
	priority: number;
	guidance: string;
}

export const VIB_WORKFLOW_SKILLS = CANONICAL_VIB_WORKFLOW_SKILLS;

export type VibWorkflowSkill = CanonicalVibWorkflowSkill;

export const VIB_SKILL_KEYWORD_DEFINITIONS: readonly SkillKeywordDefinition[] = [
	{
		keyword: "$deep-interview",
		skill: "deep-interview",
		priority: 8,
		guidance: "Activate Vibrato deep-interview requirements workflow",
	},
	{
		keyword: "$ralplan",
		skill: "ralplan",
		priority: 9,
		guidance: "Activate Vibrato ralplan planning workflow",
	},
	{
		keyword: "$ultragoal",
		skill: "ultragoal",
		priority: 8,
		guidance: "Activate Vibrato ultragoal durable goal workflow",
	},
	{
		keyword: "$autoresearch",
		skill: "autoresearch",
		priority: 8,
		guidance: "Activate Vibrato autoresearch research-mission workflow",
	},
] as const;

export function isVibWorkflowSkill(value: string): value is VibWorkflowSkill {
	return (VIB_WORKFLOW_SKILLS as readonly string[]).includes(value);
}

export function compareSkillKeywordMatches(
	a: { priority: number; keyword: string },
	b: { priority: number; keyword: string },
): number {
	if (b.priority !== a.priority) return b.priority - a.priority;
	if (b.keyword.length !== a.keyword.length) return b.keyword.length - a.keyword.length;
	return a.keyword.localeCompare(b.keyword);
}
