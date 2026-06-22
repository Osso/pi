import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export default function approvalControlsExtension(pi: ExtensionAPI) {
	pi.registerCommand("approvals", {
		description: "Select approval preset",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			ctx.showApprovalSelector();
			ctx.ui.setEditorText("");
		},
	});

	pi.registerCommand("sandbox", {
		description: "Select sandbox profile",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			ctx.showSandboxSelector();
			ctx.ui.setEditorText("");
		},
	});
}
