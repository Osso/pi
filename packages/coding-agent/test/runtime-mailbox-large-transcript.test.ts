import { appendFileSync, closeSync, fsyncSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { deliverClaimedRuntimeMailboxMessages } from "../src/core/runtime-mailbox-delivery.ts";
import {
	claimRuntimeMailboxMessages,
	enqueueRuntimeMailboxMessage,
	type RuntimeMailboxMessage,
	readRuntimeMailboxMessage,
	registerRuntimeMailboxListener,
} from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const recipient = { agentId: null, sessionId: "large-transcript-recipient" };
const sender = { agentId: null, sessionId: "large-transcript-sender" };
const TRANSCRIPT_BYTES = 200 * 1024 * 1024;

/** Append ~2 KB assistant entries until the transcript matches a long-running supervisor session. */
function padTranscript(sessionPath: string): void {
	const lines: string[] = [];
	for (let index = 0; index < 1024; index += 1) {
		const entry = {
			type: "message",
			id: `padding-${index}`,
			parentId: index === 0 ? null : `padding-${index - 1}`,
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: `Checking the floor resolver output ${index}. `.repeat(12) },
					{ type: "text", text: `Next I will rerun the navigation probe ${index}. `.repeat(6) },
					{
						type: "toolCall",
						id: `call-${index}`,
						name: "bash",
						arguments: { command: `cargo test -p game-server navigation_${index} -- --nocapture`, timeout: 600 },
					},
				],
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-6.1-terra",
				usage: { input: 1200, output: 340, cacheRead: 280000, cacheWrite: 0, totalTokens: 281540 },
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		};
		lines.push(JSON.stringify(entry));
	}
	const chunk = `${lines.join("\n")}\n`;
	for (let written = 0; written < TRANSCRIPT_BYTES; written += chunk.length) appendFileSync(sessionPath, chunk);
	const fd = openSync(sessionPath, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

describe("runtime mailbox delivery with a large recipient transcript", () => {
	let directory: string;
	let controlDbPath: string;
	let sessionManager: SessionManager;
	let store: MultiAgentStore;
	let sessionPath: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-mailbox-large-transcript-"));
		controlDbPath = join(directory, "control.sqlite");
		sessionManager = SessionManager.create(directory, join(directory, "sessions"), { id: recipient.sessionId });
		sessionManager.setMetadataControlDbPath(controlDbPath);
		store = MultiAgentStore.fromSessionManager(sessionManager);
		const persistence = store.getPersistenceTarget();
		if (!persistence) throw new Error("Expected persisted store");
		sessionPath = persistence.sessionPath;
		registerRuntimeMailboxListener(controlDbPath, recipient, process.pid, sessionPath);
		sessionManager.persistForRecovery();
		padTranscript(sessionPath);
	});

	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	function claimMessage(body: string): RuntimeMailboxMessage {
		const message = store.recordOutboundSessionMessage({ fromAgentId: "main", toAgentId: "main", body });
		enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "message",
			recipient,
			sender,
			storeRef: { messageId: message.id, sessionPath },
		});
		const [claimed] = claimRuntimeMailboxMessages(controlDbPath, recipient);
		if (!claimed) throw new Error("Expected a claimed mailbox message");
		return claimed;
	}

	function deliver(message: RuntimeMailboxMessage, prompt: (accept: () => void) => Promise<void>) {
		return deliverClaimedRuntimeMailboxMessages({
			controlDbPath,
			messages: [message],
			recipientSessionId: recipient.sessionId,
			sessionManager,
			intercept: async () => false,
			onAccepted: () => {},
			prompt: (text, accept) =>
				prompt(() => accept({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() })),
		});
	}

	it("delivers an accepted message without stalling on the transcript", async () => {
		const message = claimMessage("child finished");
		const startedAt = performance.now();
		await deliver(message, async (accept) => accept());
		const elapsedMs = performance.now() - startedAt;

		expect(readRuntimeMailboxMessage(controlDbPath, message.id)).toBeUndefined();
		expect(elapsedMs).toBeLessThan(150);
	});

	it("returns a message to pending when the prompt fails before acceptance", async () => {
		const message = claimMessage("not accepted");
		await expect(
			deliver(message, async () => {
				throw new Error("model unavailable");
			}),
		).rejects.toThrow("model unavailable");

		expect(readRuntimeMailboxMessage(controlDbPath, message.id)?.status).toBe("pending");
	});

	it("keeps a message delivered when the turn fails after acceptance", async () => {
		const message = claimMessage("accepted then failed");
		await expect(
			deliver(message, async (accept) => {
				accept();
				throw new Error("turn failed later");
			}),
		).rejects.toThrow("turn failed later");

		expect(readRuntimeMailboxMessage(controlDbPath, message.id)).toBeUndefined();
	});
});
