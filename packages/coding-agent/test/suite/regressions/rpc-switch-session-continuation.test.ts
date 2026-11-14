import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

describe("RPC switch_session continuation", () => {
	it("continues an interrupted session after switching to it, as startup does", async () => {
		await withHeadlessPi(async (agent) => {
			const sessionPath = join(agent.paths.sessionDir, "interrupted.jsonl");
			const timestamp = new Date().toISOString();
			const entries = [
				{ type: "session", version: 3, id: "interrupted-session", timestamp, cwd: agent.paths.workspaceDir },
				{
					type: "message",
					id: "user-1",
					parentId: null,
					timestamp,
					message: { role: "user", content: "finish the interrupted task", timestamp: Date.now() },
				},
			];
			writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

			expect(await agent.send({ type: "switch_session", sessionPath })).toMatchObject({ success: true });

			const request = await agent.waitForLlmRequest();
			expect(request.userMessages).toContain("finish the interrupted task");
		});
	});
});
