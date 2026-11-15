import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { HeadlessLlmRequest, HeadlessPi } from "./headless-pi.ts";

/** Answers the main thread's next model request with a fresh `spawn_agent` call and returns that request. */
export async function spawnFreshAgentFromMain(
	pi: HeadlessPi,
	displayName: string,
	prompt: string,
): Promise<HeadlessLlmRequest> {
	const mainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
	pi.respondToLlmRequest(
		mainRequest.id,
		fauxAssistantMessage(fauxToolCall("spawn_agent", { context: "fresh", displayName, prompt }), {
			stopReason: "toolUse",
		}),
	);
	return mainRequest;
}
