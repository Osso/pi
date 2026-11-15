import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";
import { spawnFreshAgentFromMain } from "../headless-spawn.ts";

const toolNames = (tools: Array<{ name: string }> | undefined) => (tools ?? []).map((tool) => tool.name);

describe("set_session_name in child agents", () => {
	it("is offered to the main session but not to a spawned child, which cannot use it", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Spawn a child" });
			const mainRequest = await spawnFreshAgentFromMain(pi, "Naming probe child", "Report done");
			const spawned = await pi.waitForAgent((agent) => agent.displayName === "Naming probe child");
			const childRequest = await pi.waitForLlmRequest((request) => request.agentId === spawned.id);

			expect(toolNames(mainRequest.tools)).toContain("set_session_name");
			expect(toolNames(childRequest.tools)).not.toContain("set_session_name");
		});
	});
});
