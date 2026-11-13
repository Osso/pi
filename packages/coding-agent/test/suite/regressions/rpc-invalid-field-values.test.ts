import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

// Raw wire input: the typed client cannot express these invalid values.
const raw = (json: string) => JSON.parse(json);

describe("RPC field validation", () => {
	it("rejects an unknown prompt streamingBehavior instead of treating it as steer", async () => {
		await withHeadlessPi(async (agent) => {
			expect(
				await agent.send(raw('{"type":"prompt","message":"later","streamingBehavior":"followup"}')),
			).toMatchObject({ command: "prompt", success: false, error: "Invalid streamingBehavior: followup" });
			expect(await agent.send({ type: "get_state" })).toMatchObject({ data: { messageCount: 0 } });
		});
	});

	it("rejects non-boolean auto-compaction and auto-retry values", async () => {
		await withHeadlessPi(async (agent) => {
			expect(await agent.send(raw('{"type":"set_auto_compaction","enabled":"false"}'))).toMatchObject({
				command: "set_auto_compaction",
				success: false,
				error: "enabled must be a boolean",
			});
			expect(await agent.send(raw('{"type":"set_auto_retry","enabled":"false"}'))).toMatchObject({
				command: "set_auto_retry",
				success: false,
				error: "enabled must be a boolean",
			});
			expect(await agent.send({ type: "get_state" })).toMatchObject({ data: { autoCompactionEnabled: true } });
		});
	});

	it("rejects a bash command that is missing or not a string instead of running it", async () => {
		await withHeadlessPi(async (agent) => {
			for (const request of ['{"type":"bash"}', '{"type":"bash","command":7}']) {
				expect(await agent.send(raw(request))).toMatchObject({
					command: "bash",
					success: false,
					error: "command must be a string",
				});
			}
			expect(await agent.send({ type: "get_messages" })).toMatchObject({ data: { messages: [] } });
		});
	});
});
