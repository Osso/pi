import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

function writeInterruptedSession(sessionDir: string, workspaceDir: string): string {
	const sessionPath = join(sessionDir, "interrupted.jsonl");
	const timestamp = new Date().toISOString();
	const entries = [
		{ type: "session", version: 3, id: "interrupted-session", timestamp, cwd: workspaceDir },
		{
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp,
			message: { role: "user", content: "finish the interrupted task", timestamp: Date.now() },
		},
	];
	writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return sessionPath;
}

describe("RPC switch_session continuation", () => {
	it("continues an interrupted session after an extension command switches to it", async () => {
		await withHeadlessPi(async (agent) => {
			writeFileSync(
				join(agent.paths.agentDir, "extensions", "switch-probe.ts"),
				`export default function (pi) {
	pi.registerCommand("switch-probe", { handler: async (args, ctx) => { await ctx.switchSession(args.trim()); } });
}
`,
			);
			await agent.restart();
			const sessionPath = writeInterruptedSession(agent.paths.sessionDir, agent.paths.workspaceDir);

			expect(await agent.send({ type: "prompt", message: `/switch-probe ${sessionPath}` })).toMatchObject({
				success: true,
			});

			const request = await agent.waitForLlmRequest();
			expect(request.userMessages).toContain("finish the interrupted task");
		});
	});

	it("continues an interrupted session after switching to it, as startup does", async () => {
		await withHeadlessPi(async (agent) => {
			const sessionPath = writeInterruptedSession(agent.paths.sessionDir, agent.paths.workspaceDir);

			expect(await agent.send({ type: "switch_session", sessionPath })).toMatchObject({ success: true });

			const request = await agent.waitForLlmRequest();
			expect(request.userMessages).toContain("finish the interrupted task");
		});
	});
});
