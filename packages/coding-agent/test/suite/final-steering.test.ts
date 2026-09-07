import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";

it("delivers both final steering messages before enforcing end_turn on an uninterrupted response", async () => {
	await withHeadlessPi(async (agent) => {
		const steering = ["First final steering request", "Second final steering request"];
		const extensionsDir = join(agent.paths.agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(
			join(extensionsDir, "final-steering.ts"),
			`export default function (pi) {
				let injected = false;
				pi.on("turn_end", (event) => {
					if (injected || event.message.role !== "assistant" ||
						!event.message.content.some((part) => part.type === "text" && part.text === "Initial text-only response")) return;
					injected = true;
					for (const message of ${JSON.stringify(steering)}) pi.sendUserMessage(message, { deliverAs: "steer" });
				});
			}`,
		);
		await agent.restart();
		await agent.send({ type: "prompt", message: "Start final steering regression" });
		let request = await agent.waitForLlmRequest();
		agent.respondToLlmRequest(request.id, fauxAssistantMessage("Initial text-only response"));
		const runtimeInstruction = "Do not continue, repeat, or infer a new user request";
		for (const message of steering) {
			const previousId = request.id;
			request = await agent.waitForLlmRequest(
				(candidate) => candidate.id !== previousId && candidate.userMessages.includes(message),
			);
			expect(request.userMessages.at(-1)).toBe(message);
			expect(request.userMessages.some((text) => text.includes(runtimeInstruction))).toBe(false);
			agent.respondToLlmRequest(request.id, fauxAssistantMessage(`Handled ${message}`));
		}
		const previousId = request.id;
		request = await agent.waitForLlmRequest(
			(candidate) =>
				candidate.id !== previousId && candidate.userMessages.some((text) => text.includes(runtimeInstruction)),
		);
		expect(request.userMessages.at(-1)).toContain(runtimeInstruction);
		agent.respondToLlmRequest(
			request.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Both steering requests handled" }), {
				stopReason: "toolUse",
			}),
		);
		await agent.waitForEvent((event) => event.type === "agent_end");
		const entries = agent.readSessionEntries(null);
		for (const text of steering) {
			expect(
				entries.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						(typeof entry.message.content === "string"
							? entry.message.content === text
							: entry.message.content.some((part) => part.type === "text" && part.text === text)),
				),
			).toHaveLength(1);
		}
	});
}, 60_000);
