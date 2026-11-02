export const CHILD_DISABLED_AGENT_TOOL_NAMES = [
	"agent_viewer",
	"answer_question",
	"attach_session_agent",
	"close_agent",
	"set_agent_model",
	"rename_agent",
	"spawn_agent",
	"steer_agent",
	"wait_agent",
] as const;

export const SUPERVISOR_ONLY_TOOL_NAMES = ["ask_supervisor", "manage_goal"] as const;

export const STANDALONE_DISABLED_TOOL_NAMES: ReadonlySet<string> = new Set([
	...CHILD_DISABLED_AGENT_TOOL_NAMES,
	...SUPERVISOR_ONLY_TOOL_NAMES,
	"list_agents",
	"send_agent_message",
	"contact_parent",
	"list_sessions",
	"channel_post",
	"resume_session",
]);
