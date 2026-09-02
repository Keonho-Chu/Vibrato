import type { CanonicalVibWorkflowSkill } from "./active-state";

/**
 * Canonical initial phase for each Vibrato workflow skill. Used by both
 * `recordSkillActivation` (UserPromptSubmit hook seeding initial mode-state)
 * and the `vib state <caller> handoff --to <callee>` runtime when promoting
 * the callee.
 *
 * Keeping this mapping in a neutral skill-state module avoids cycles between
 * `vib-runtime/state-runtime.ts` and `hooks/skill-state.ts` (which pulls in
 * session-manager and ultragoal verification code).
 */
export function initialPhaseForSkill(skill: CanonicalVibWorkflowSkill | string): string {
	if (skill === "deep-interview") return "interviewing";
	if (skill === "ultragoal") return "goal-planning";
	if (skill === "ralplan") return "planner";
	if (skill === "autoresearch") return "intake";
	return "planning";
}
