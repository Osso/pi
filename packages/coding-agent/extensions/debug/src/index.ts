import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

interface DebugReplController {
	enable(sessionId: string): Promise<string>;
	disable(): Promise<void>;
}

export default function debugExtension(pi: ExtensionAPI, getController: () => DebugReplController): void {
	pi.registerCommand("debug", {
		description: "Enable or disable the privileged live-process debug REPL",
		handler: async (args, ctx) => {
			const debugRepl = getController();
			const action = args.trim();
			if (action === "off") {
				await debugRepl.disable();
				ctx.ui.notify("Debug REPL disabled", "info");
				return;
			}
			if (action) {
				ctx.ui.notify("Usage: /debug [off]", "warning");
				return;
			}

			const sessionId = ctx.sessionManager.getSessionId();
			await debugRepl.enable(sessionId);
			ctx.ui.notify(`Debug REPL enabled: pi debug attach ${sessionId}`, "warning");
		},
	});
}
