import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";

const SECRET = "rpc-secret-value-7f3a";
const LABEL = "OpenRouter API key";

describe("ask_secret over RPC", () => {
	it("asks the client for a masked value, writes it to the file and keeps it out of the session", async () => {
		await withHeadlessPi(async (agent) => {
			const destination = join(agent.paths.tempDir, "secrets", "openrouter.key");
			await agent.send({ type: "prompt", message: "Store my OpenRouter key." });
			agent.respondToLlmRequest(
				(await agent.waitForLlmRequest()).id,
				fauxAssistantMessage([fauxToolCall("ask_secret", { path: destination, label: LABEL })], {
					stopReason: "toolUse",
				}),
			);

			const request = await agent.waitForExtensionUiRequest((candidate) => candidate.method === "input");
			expect(request).toMatchObject({ method: "input", title: LABEL, secret: true });
			await agent.respondToExtensionUiRequest({ type: "extension_ui_response", id: request.id, value: SECRET });

			const followUp = await agent.waitForLlmRequest((candidate) =>
				JSON.stringify(candidate.messages).includes("Saved secret"),
			);
			agent.respondToLlmRequest(
				followUp.id,
				fauxAssistantMessage([{ type: "text", text: "Saved." }, fauxToolCall("end_turn", { reason: "Saved." })], {
					stopReason: "toolUse",
				}),
			);
			await agent.waitForEvent((event) => event.type === "agent_end");

			expect(readFileSync(destination, "utf8")).toBe(`${SECRET}\n`);
			expect(JSON.stringify(followUp.messages)).not.toContain(SECRET);
			const transcript = readFileSync(agent.sessionFile, "utf8");
			expect(transcript).toContain(`Saved secret to ${destination}.`);
			expect(transcript).not.toContain(SECRET);
		});
	}, 60_000);
});
