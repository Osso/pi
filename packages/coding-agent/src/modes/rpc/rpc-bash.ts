import type { AgentSession } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";

/**
 * Run an RPC `bash` command through the same `user_bash` routing as `!` commands in interactive mode.
 * A failing handler rejects, so the command never falls back to local execution.
 */
export async function runRpcBash(
	session: AgentSession,
	command: string,
	excludeFromContext?: boolean,
): Promise<BashResult> {
	const eventResult = await session.extensionRunner.emitUserBash({
		type: "user_bash",
		command,
		excludeFromContext: excludeFromContext ?? false,
		cwd: session.sessionManager.getCwd(),
	});
	if (eventResult?.result) {
		session.recordBashResult(command, eventResult.result, { excludeFromContext });
		return eventResult.result;
	}
	return session.executeBash(command, undefined, { excludeFromContext, operations: eventResult?.operations });
}
