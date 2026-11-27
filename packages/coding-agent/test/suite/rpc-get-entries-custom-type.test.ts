import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";

describe("RPC get_entries customType", () => {
	it("returns only the custom entries of that type, in append order, live as entry_appended too", async () => {
		await withHeadlessPi(
			async (agent) => {
				const appended = agent.waitForEvent(
					(event) =>
						event.type === "entry_appended" &&
						(event.entry as { data?: { message?: string } }).data?.message === "Continue.",
				);
				expect(await agent.send({ type: "prompt", message: "/status-entries" })).toMatchObject({ success: true });
				await appended;
				const response = await agent.send({ type: "get_entries", customType: "supervisor-status" });
				if (!response.success || response.command !== "get_entries") throw new Error(JSON.stringify(response));
				expect(response.data.entries.map((entry) => (entry as { data?: unknown }).data)).toEqual([
					{ message: "Waiting for Supervisor…", displayId: "d1" },
					{ message: "Continue.", displayId: "d1" },
				]);
			},
			{ cliPath: join(import.meta.dirname, "fixtures", "custom-entry-cli.ts") },
		);
	}, 60_000);
});
