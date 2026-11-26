import { describe, expect, it } from "vitest";
import type { HeadlessPi } from "./headless-pi.ts";
import { withHeadlessPi } from "./headless-pi.ts";

/** Answers the next `select` titled `title` with the option starting with `prefix`; returns its options. */
async function choose(agent: HeadlessPi, title: string, prefix: string | undefined): Promise<string[]> {
	const request = await agent.waitForExtensionUiRequest(
		(candidate) => candidate.method === "select" && candidate.title === title,
	);
	const options = (request as { options: string[] }).options;
	const value = prefix === undefined ? undefined : options.find((option) => option.startsWith(prefix));
	await agent.respondToExtensionUiRequest(
		value === undefined
			? { type: "extension_ui_response", id: request.id, cancelled: true }
			: { type: "extension_ui_response", id: request.id, value },
	);
	return options;
}

async function notified(agent: HeadlessPi, message: string): Promise<void> {
	await agent.waitForExtensionUiRequest((request) => request.method === "notify" && request.message === message);
}

describe("approval and sandbox selectors over RPC", () => {
	it("saves the chosen sandbox profile and approval preset and marks them current", async () => {
		await withHeadlessPi(async (agent) => {
			let command = agent.send({ type: "prompt", message: "/sandbox" });
			await choose(agent, "Save sandbox profile to", "session");
			const before = await choose(agent, "Sandbox profile", "Read Only");
			expect(before).toEqual(["Inherit global/project (current)", "Read Only", "Workspace Write", "Full Access"]);
			await notified(agent, "Saved sandbox profile read-only to session scope.");
			await command;

			command = agent.send({ type: "prompt", message: "/sandbox" });
			await choose(agent, "Save sandbox profile to", "session");
			const after = await choose(agent, "Sandbox profile", undefined);
			expect(after).toContain("Read Only (current)");
			await command;

			command = agent.send({ type: "prompt", message: "/approvals" });
			await choose(agent, "Save approval preset to", "global");
			await choose(agent, "Approval preset", "Never Ask/Deny");
			await notified(
				agent,
				"Saved approval preset Never Ask/Deny to global settings. Restart pi for this to take effect.",
			);
			await command;

			command = agent.send({ type: "prompt", message: "/approvals" });
			await choose(agent, "Save approval preset to", "global");
			expect(await choose(agent, "Approval preset", undefined)).toContain("Never Ask/Deny (current)");
			await command;
		});
	}, 60_000);
});
