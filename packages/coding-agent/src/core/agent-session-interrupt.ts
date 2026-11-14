import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "./agent-session.ts";
import type { InputSource } from "./extensions/types.ts";
import { convertToLlm } from "./messages.ts";

/** Preserve actual queued content before abort clears the delivery queues. */
export async function interruptSession(session: AgentSession, message: string, source: InputSource): Promise<void> {
	const content = convertToLlm(session.agent.clearAllQueues())
		.filter((queued) => queued.role === "user")
		.flatMap<TextContent | ImageContent>((queued) =>
			typeof queued.content === "string" ? [{ type: "text", text: queued.content }] : queued.content,
		);
	const text = [...content.filter((part) => part.type === "text").map((part) => part.text), message]
		.filter((part) => part.trim())
		.join("\n\n")
		.trim();
	const images = content.filter((part) => part.type === "image");
	if (!text && images.length === 0) {
		await session.abort();
		return;
	}
	const releasePendingInput = session.reserveExternalUserInput();
	try {
		await session.abort();
		await session.prompt(text, {
			images,
			preflightResult: (accepted) => {
				if (accepted) releasePendingInput();
			},
			source,
			streamingBehavior: "steer",
		});
	} finally {
		releasePendingInput();
	}
}
