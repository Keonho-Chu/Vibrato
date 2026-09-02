export const COORDINATOR_MCP_PROTOCOL_VERSION = "2024-11-05";
export const COORDINATOR_MCP_SERVER_NAME = "vib-coordinator-mcp";

export const COORDINATOR_MCP_TOOL_NAMES = [
	"vib_coordinator_list_sessions",
	"vib_coordinator_read_status",
	"vib_coordinator_read_tail",
	"vib_coordinator_list_questions",
	"vib_coordinator_list_artifacts",
	"vib_coordinator_read_artifact",
	"vib_coordinator_read_coordination_status",
	"vib_coordinator_watch_events",
	"vib_coordinator_register_session",
	"vib_coordinator_start_session",
	"vib_coordinator_retire_start_session",
	"vib_coordinator_activate_session",
	"vib_coordinator_stop_session",
	"vib_coordinator_send_prompt",
	"vib_coordinator_submit_question_answer",
	"vib_coordinator_read_turn",
	"vib_coordinator_await_turn",
	"vib_coordinator_report_status",
	"vib_coordinator_register_codex_handoff",
	"vib_coordinator_read_codex_handoff",
	"vib_coordinator_ack_codex_handoff",
	"vib_delegate_plan",
	"vib_delegate_execute",
] as const;

export type CoordinatorToolName = (typeof COORDINATOR_MCP_TOOL_NAMES)[number];
