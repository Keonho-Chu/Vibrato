export const VIB_RESTRICTED_ROLE_AGENT_BASH_ENV = "VIB_RESTRICTED_ROLE_AGENT_BASH";
export const VIB_RALPLAN_ARTIFACT_ENV = "VIB_RALPLAN_ARTIFACT";

export function isRestrictedRoleAgentBash(): boolean {
	return process.env[VIB_RESTRICTED_ROLE_AGENT_BASH_ENV] === "1";
}
