import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";

describe("RPC working status event", () => {
	it("forwards extension working-message changes", async () => {
		await withHeadlessPi(async (agent) => {
			writeFileSync(
				join(agent.paths.agentDir, "extensions", "working-status-probe.ts"),
				`export default function (pi) {
	pi.registerCommand("working-status-probe", {
		handler: async (_args, ctx) => { ctx.ui.setWorkingMessage("Waiting for Supervisor"); },
	});
}
`,
			);
			await agent.restart();
			await agent.send({ type: "prompt", message: "/working-status-probe" });
			expect(await agent.waitForEvent((event) => (event as { type?: string }).type === "working_status")).toEqual({
				type: "working_status",
				message: "Waiting for Supervisor",
			});
		});
	}, 60_000);
});
