import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";

describe("RPC extension state for late clients", () => {
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
			{ cliPath: join(import.meta.dirname, "fixtures", "extension-state-cli.ts") },
		);
	}, 60_000);

	it("get_state returns the footer statuses extensions set, without cleared ones", async () => {
		await withHeadlessPi(
			async (agent) => {
				expect(await agent.send({ type: "prompt", message: "/set-statuses" })).toMatchObject({ success: true });
				await agent.waitForExtensionUiRequest(
					(request) =>
						request.method === "setStatus" && request.statusKey === "old" && request.statusText === undefined,
				);
				expect(await agent.send({ type: "get_state" })).toMatchObject({
					data: { extensionStatuses: { goal: "Goal: fix the footer", bwrap: "bwrap: workspace" } },
				});
				const state = await agent.send({ type: "get_state" });
				if (!state.success || state.command !== "get_state") throw new Error(JSON.stringify(state));
				expect(Object.keys(state.data.extensionStatuses)).not.toContain("old");
			},
			{ cliPath: join(import.meta.dirname, "fixtures", "extension-state-cli.ts") },
		);
	}, 60_000);
});
