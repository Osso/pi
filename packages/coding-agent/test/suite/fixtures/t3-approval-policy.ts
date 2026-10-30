import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

// Approval contract from pingdotgg/t3code 32ecd71726fee16f335484c1f95cbce126d461f6,
// packages/provider-pi/src/server/mcpExtensionSource.ts. The full upstream bridge
// is separately exercised against a local MCP server; this fixture needs no network.
export default function t3ApprovalPolicy(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		const mode = process.env.T3_PI_RUNTIME_MODE;
		if (mode === "full-access") return;
		if (["read", "grep", "find", "ls"].includes(event.toolName)) return;
		if (mode === "auto-accept-edits" && ["edit", "write"].includes(event.toolName)) return;
		const approved = await ctx.ui.confirm(`Allow ${event.toolName}?`, JSON.stringify(event.input), {
			signal: ctx.signal,
		});
		if (!approved) return { block: true, reason: `${event.toolName} was declined in T3 Code.` };
	});
}
