import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type { InputSource } from "./extensions/types.ts";
import { formatRuntimeMailboxPrompt } from "./runtime-coordination-format.ts";
import { acceptRuntimeMailboxMessages, releaseUnacceptedRuntimeMailboxMessages } from "./runtime-mailbox-acceptance.ts";
import type { RuntimeMailboxMessage } from "./session-control-db.ts";
import type { SessionManager } from "./session-manager.ts";

export function createRuntimeMailboxUserMessage(
	text: string,
	source: InputSource,
	images: ImageContent[] = [],
): AgentMessage {
	return { role: "user", content: [{ type: "text", text }, ...images], inputSource: source, timestamp: Date.now() };
}

interface ClaimedMailboxDelivery {
	controlDbPath: string;
	messages: RuntimeMailboxMessage[];
	recipientSessionId: string;
	sessionManager: SessionManager;
	intercept: (message: RuntimeMailboxMessage) => Promise<boolean>;
	onAccepted: (message: RuntimeMailboxMessage) => void;
	steer?: (message: AgentMessage) => void;
	prompt: (text: string, accept: (message?: AgentMessage) => void) => Promise<void>;
}

export async function deliverClaimedRuntimeMailboxMessages(delivery: ClaimedMailboxDelivery): Promise<boolean> {
	const { controlDbPath, messages, sessionManager } = delivery;
	const accept = (batch: RuntimeMailboxMessage[], message?: AgentMessage) => {
		acceptRuntimeMailboxMessages(sessionManager, controlDbPath, batch, message);
		for (const accepted of batch) delivery.onAccepted(accepted);
	};
	try {
		const promptMessages: RuntimeMailboxMessage[] = [];
		for (const message of messages) {
			if (await delivery.intercept(message)) accept([message]);
			else promptMessages.push(message);
		}
		if (promptMessages.length === 0) return false;
		const prompt = promptMessages
			.map((message) => formatRuntimeMailboxPrompt(message, delivery.recipientSessionId))
			.join("\n\n");
		if (delivery.steer) {
			const message = createRuntimeMailboxUserMessage(prompt, "extension");
			delivery.steer(message);
			accept(promptMessages, message);
			return true;
		}
		await delivery.prompt(prompt, (message) => accept(promptMessages, message));
		return false;
	} finally {
		releaseUnacceptedRuntimeMailboxMessages(sessionManager, controlDbPath, messages);
	}
}
