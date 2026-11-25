import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { type HeadlessPi, withHeadlessPi } from "../headless-pi.ts";

function writeScopeRules(agentDir: string): void {
	for (const dir of ["main", "sub-agent", "supervisor"]) {
		mkdirSync(join(agentDir, "rules", dir), { recursive: true });
		writeFileSync(join(agentDir, "rules", dir, "rule.md"), `${dir.toUpperCase()}_SCOPE_RULE`);
	}
}

/** The scope rules the next model request carries, in prompt order. */
async function promptScopeRules(agent: HeadlessPi, message: string): Promise<string[]> {
	await agent.send({ type: "prompt", message });
	const request = await agent.waitForLlmRequest((candidate) => candidate.userMessages.includes(message));
	agent.respondToLlmRequest(
		request.id,
		fauxAssistantMessage([{ type: "text", text: "Done." }, fauxToolCall("end_turn", { reason: "Done." })], {
			stopReason: "toolUse",
		}),
	);
	await agent.waitForEvent((event) => event.type === "agent_end");
	return request.systemPrompt?.match(/[A-Z-]+_SCOPE_RULE/g) ?? [];
}

describe("supervisor rules scope in a real Pi process", () => {
	it("adds rules/supervisor/ only once the session is the configured Supervisor", async () => {
		await withHeadlessPi(async (agent) => {
			// A session file exists only after its first turn, and restart resumes that file.
			await promptScopeRules(agent, "Create the session");
			writeScopeRules(agent.paths.agentDir);
			await agent.restart();
			expect(await promptScopeRules(agent, "As a main session")).toEqual(["MAIN_SCOPE_RULE"]);

			const settingsPath = join(agent.paths.agentDir, "settings.json");
			const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
			writeFileSync(settingsPath, JSON.stringify({ ...settings, supervisor: { sessionId: agent.sessionId } }));
			await agent.restart();
			expect(await promptScopeRules(agent, "As the Supervisor")).toEqual([
				"MAIN_SCOPE_RULE",
				"SUPERVISOR_SCOPE_RULE",
			]);
		});
	});
});
