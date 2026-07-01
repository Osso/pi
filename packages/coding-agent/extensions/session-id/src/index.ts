import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

export default function sessionIdExtension(pi: ExtensionAPI) {
	pi.registerCommand("session-id", {
		description: "Show the current session id",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Session ID: ${ctx.sessionManager.getSessionId()}`, "info");
		},
	});
}
