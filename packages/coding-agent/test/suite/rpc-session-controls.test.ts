import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";

describe("RPC TUI session controls", () => {
	it("clears names, stores project trust, relocates cwd, reloads, imports, and continues", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "set_session_name", name: "RPC control test" });
			expect(await agent.send({ type: "clear_session_name" })).toMatchObject({
				command: "clear_session_name",
				success: true,
			});
			const state = (await agent.send({ type: "get_state" })) as { data: { sessionName?: string } };
			expect(state.data).not.toHaveProperty("sessionName");

			expect(await agent.send({ type: "set_project_trust", trusted: true })).toMatchObject({
				command: "set_project_trust",
				success: true,
				data: { decision: true },
			});
			expect(await agent.send({ type: "get_project_trust" })).toMatchObject({
				command: "get_project_trust",
				data: { decision: true },
			});

			expect(await agent.send({ type: "set_cwd", cwd: agent.paths.workspaceDir })).toMatchObject({
				command: "set_cwd",
				success: true,
				data: { cwd: agent.paths.workspaceDir },
			});
			expect(await agent.send({ type: "reload" })).toMatchObject({ command: "reload", success: true });
			expect(await agent.send({ type: "continue" })).toMatchObject({ command: "continue", success: true });

			const sourcePath = join(agent.paths.sessionDir, "import-source.jsonl");
			writeFileSync(
				sourcePath,
				`${JSON.stringify({ type: "session", version: 3, id: "import-source", timestamp: new Date().toISOString(), cwd: agent.paths.workspaceDir })}\n`,
			);
			const imported = await agent.send({ type: "import_session", path: sourcePath });
			expect(imported).toMatchObject({ command: "import_session", success: true, data: { cancelled: false } });
		});
	}, 60_000);
});
