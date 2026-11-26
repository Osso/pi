import { Type } from "typebox";
import type { ToolDefinition } from "../../../src/core/extensions/types.ts";
import { isVerifiedPiRuntimeProcess } from "../../../src/core/runtime-process.ts";
import { readSessionHealth } from "../../../src/core/session-control-db/session-health.ts";
import { sendSupervisorInterrupt } from "../../../src/supervisor/interrupt.ts";
import { isRemoteHost } from "../../../src/supervisor/mail.ts";

const interruptSessionParameters = Type.Object({
	sessionId: Type.String({ description: "Main session ID to interrupt." }),
	host: Type.Optional(Type.String({ description: "Host running the session; omit for this host." })),
	reason: Type.String({ description: "Why the turn is stopped and what to do next; the session continues with it." }),
});

/** Stops a main session's running tool call and turn; the session then continues with the reason. */
export function createInterruptSessionTool(): ToolDefinition<typeof interruptSessionParameters, Record<string, never>> {
	return {
		name: "interrupt_session",
		label: "Interrupt session",
		description:
			"Stop a main session's running tool call and turn, on this host or another host through the relay. The session keeps its identity and continues with the reason as its next message; its background jobs and agents keep running.",
		promptSnippet: "Stop a session stuck in a long tool call and resume it with a reason",
		promptGuidelines: [
			"Use interrupt_session only to unblock a session that inspect_session shows stuck in a long tool call or turn; state the reason and the next step.",
		],
		parameters: interruptSessionParameters,
		approvalRequired: false,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const controlDbPath = ctx.controlDbPath;
			if (!controlDbPath) throw new Error("interrupt_session requires the Pi control database");
			const { sessionId, host, reason } = params;
			if (!reason.trim()) throw new Error("interrupt_session requires a reason");
			const supervisorSessionId = ctx.sessionManager.getSessionId();
			const remote = isRemoteHost(host);
			if (!remote && sessionId === supervisorSessionId) throw new Error("The Supervisor cannot interrupt itself");
			if (!remote) {
				const pid = readSessionHealth(controlDbPath, sessionId)?.pid;
				if (!pid || !isVerifiedPiRuntimeProcess(pid)) throw new Error(`Session ${sessionId} is not running here`);
			}
			sendSupervisorInterrupt(controlDbPath, supervisorSessionId, { sessionId, host }, reason);
			const text = remote
				? `Interrupt queued for session ${sessionId} on host ${host}; the relay delivers it.`
				: `Interrupt sent to session ${sessionId}.`;
			return { content: [{ type: "text", text }], details: {} };
		},
	};
}
