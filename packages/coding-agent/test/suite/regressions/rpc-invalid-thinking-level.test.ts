import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

describe("RPC set_thinking_level validation", () => {
	it("rejects an unknown level instead of silently turning thinking off", async () => {
		await withHeadlessPi(
			async (agent) => {
				expect((await agent.send({ type: "set_thinking_level", level: "high" })).success).toBe(true);

				// Raw wire input: the typed client cannot express an invalid level.
				const response = await agent.send(JSON.parse('{"type":"set_thinking_level","level":"hgh"}'));
				expect(response).toMatchObject({
					command: "set_thinking_level",
					success: false,
					error: "Invalid thinking level: hgh",
				});

				const state = await agent.send({ type: "get_state" });
				expect(state).toMatchObject({ success: true, data: { thinkingLevel: "high" } });
			},
			{ model: "headless-faux-reasoning" },
		);
	});
});
