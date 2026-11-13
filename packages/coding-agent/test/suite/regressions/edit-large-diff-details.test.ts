import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

interface ToolResultMessage {
	role: string;
	details?: { diff?: string; patch?: string };
}

async function readEditDetails(agent: { send(command: object): Promise<unknown> }) {
	const response = (await agent.send({ type: "get_messages" })) as { data: { messages: ToolResultMessage[] } };
	return response.data.messages.find((message) => message.role === "toolResult")?.details;
}

it("keeps the diff and patch of a large edit in the live and persisted tool result", async () => {
	await withHeadlessPi(async (agent) => {
		// 120 changed lines: about 5.5KB of old text, so diff + patch exceed the 11KB model-text cap.
		const file = join(agent.paths.workspaceDir, "values.ts");
		const oldLines = Array.from({ length: 120 }, (_, index) => `export const value${index} = "old value ${index}";`);
		const newLines = oldLines.map((line) => line.replace("old", "new"));
		writeFileSync(file, `// header\n${oldLines.join("\n")}\n// footer\n`);

		await agent.send({ type: "prompt", message: "Rename the values" });
		const first = await agent.waitForLlmRequest();
		agent.respondToLlmRequest(
			first.id,
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: file,
						edits: [{ oldText: oldLines.join("\n"), newText: newLines.join("\n") }],
					}),
				],
				{ stopReason: "toolUse" },
			),
		);
		// The tool result is stored before the follow-up model request starts.
		const second = await agent.waitForLlmRequest();
		agent.respondToLlmRequest(second.id, fauxAssistantMessage("Renamed"));

		const live = await readEditDetails(agent);
		expect(live?.diff).toContain('+121 export const value119 = "new value 119";');
		expect(live?.patch).toContain('+export const value119 = "new value 119";');

		const persisted = agent
			.readSessionEntries(null)
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(
			persisted?.type === "message" && persisted.message.role === "toolResult" && persisted.message.details,
		).toEqual(live);
	});
}, 60_000);
