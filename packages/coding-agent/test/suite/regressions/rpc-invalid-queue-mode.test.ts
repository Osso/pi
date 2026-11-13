import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

describe("RPC queue mode validation", () => {
	it("rejects unknown steering and follow-up modes and keeps the current modes", async () => {
		await withHeadlessPi(async (agent) => {
			// Raw wire input: the typed client cannot express an invalid mode.
			expect(await agent.send(JSON.parse('{"type":"set_steering_mode","mode":"bad"}'))).toMatchObject({
				command: "set_steering_mode",
				success: false,
				error: "Invalid steering mode: bad",
			});
			expect(await agent.send(JSON.parse('{"type":"set_follow_up_mode","mode":"bad"}'))).toMatchObject({
				command: "set_follow_up_mode",
				success: false,
				error: "Invalid follow-up mode: bad",
			});

			expect(await agent.send({ type: "get_state" })).toMatchObject({
				success: true,
				data: { steeringMode: "all", followUpMode: "one-at-a-time" },
			});
		});
	});
});
