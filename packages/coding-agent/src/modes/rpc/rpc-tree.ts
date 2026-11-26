/**
 * Session-tree commands for RPC clients: the data and navigation behind the TUI's `/tree`.
 */

import type { AgentSession } from "../../core/agent-session.ts";
import type { RpcResponse, RpcTreeCommand } from "./rpc-types.ts";

export function isRpcTreeCommand(command: { type: string }): command is RpcTreeCommand {
	return command.type === "get_tree" || command.type === "navigate_tree" || command.type === "abort_branch_summary";
}

function respond(id: string | undefined, command: RpcTreeCommand["type"], data?: object): RpcResponse {
	return { id, type: "response", command, success: true, data } as RpcResponse;
}

export async function handleRpcTreeCommand(command: RpcTreeCommand, session: AgentSession): Promise<RpcResponse> {
	switch (command.type) {
		case "get_tree":
			return respond(command.id, "get_tree", {
				tree: session.sessionManager.getTree(),
				leafId: session.sessionManager.getLeafId(),
				branchSummarySkipPrompt: session.settingsManager.getBranchSummarySkipPrompt(),
			});
		case "abort_branch_summary":
			session.abortBranchSummary();
			return respond(command.id, "abort_branch_summary");
		case "navigate_tree": {
			// As in the TUI, choosing a point stops the active response; call clear_queue first to keep queued input.
			if (session.isStreaming) await session.abort();
			const result = await session.navigateTree(command.entryId, {
				summarize: command.summarize,
				customInstructions: command.customInstructions,
			});
			return respond(command.id, "navigate_tree", {
				cancelled: result.cancelled,
				aborted: result.aborted ?? false,
				editorText: result.editorText,
			});
		}
	}
}
