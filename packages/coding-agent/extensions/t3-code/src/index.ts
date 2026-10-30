import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

export default function t3CodeExtension(pi: ExtensionAPI): void {
	const extensionPath = process.env.T3_PI_MCP_EXTENSION_PATH;
	if (!extensionPath) return;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "rpc") pi.delegateToolApprovalsTo(extensionPath);
	});
}
