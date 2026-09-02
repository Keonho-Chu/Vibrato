/** Native-free canonical Vibrato workflow skill identifiers. */
export const CANONICAL_VIB_WORKFLOW_SKILLS = ["deep-interview", "ralplan", "ultragoal", "autoresearch"] as const;

export type CanonicalVibWorkflowSkill = (typeof CANONICAL_VIB_WORKFLOW_SKILLS)[number];
