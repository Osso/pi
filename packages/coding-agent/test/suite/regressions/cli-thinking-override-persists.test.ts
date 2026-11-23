import { expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

it("saves a CLI model thinking suffix so the session resumes with it", async () => {
	await withHeadlessPi(
		async (agent) => {
			const state = await agent.send({ type: "get_state" });
			expect(state).toMatchObject({ success: true, data: { thinkingLevel: "high" } });
			expect(agent.readSessionMetadata(null).thinkingLevel).toBe("high");
		},
		{ model: "headless-faux-reasoning:high" },
	);
}, 60_000);
