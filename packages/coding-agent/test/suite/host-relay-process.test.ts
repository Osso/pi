import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runHostRelay } from "../../src/core/host-relay.ts";
import {
	enqueueStoredRuntimeMailboxMessage,
	getControlDbPath,
	listRuntimeMailboxMessages,
	listSharedChannelMessagesAfter,
	postSharedChannelMessage,
	registerRuntimeMailboxListener,
	takeRuntimeMailboxMessagesForDelivery,
} from "../../src/core/session-control-db.ts";
import { createHeadlessPaths } from "./headless-pi.ts";

describe("pi relay serve process", () => {
	it("forwards over CLI stdio without provider initialization and exits on EOF", async () => {
		const paths = createHeadlessPaths();
		const localDb = join(paths.tempDir, "client.sqlite");
		const remoteDb = getControlDbPath(paths.agentDir);
		const sender = { sessionId: "stdio-client", agentId: null };
		const recipient = { sessionId: "stdio-server", agentId: null };
		registerRuntimeMailboxListener(remoteDb, recipient, process.pid);
		enqueueStoredRuntimeMailboxMessage(localDb, {
			recipientHost: hostname(),
			recipient,
			sender,
			kind: "message",
			storeRef: { sessionPath: "/client/stdio.jsonl", messageId: "stdio-message" },
			message: {
				id: "stdio-message",
				kind: "message",
				status: "pending",
				fromAgentId: "main",
				toAgentId: "main",
				body: "native relay message",
				createdAt: new Date().toISOString(),
			},
		});
		postSharedChannelMessage(localDb, { sender, body: "Restart /tmp/native-relay" });
		const child = spawn(
			process.execPath,
			["--experimental-strip-types", join(import.meta.dirname, "../../src/cli.ts"), "relay", "serve"],
			{
				cwd: paths.workspaceDir,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: paths.agentDir,
					PI_CODING_AGENT_STATE_DIR: paths.agentDir,
					PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const exited = new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		const controller = new AbortController();
		const protocol = runHostRelay({
			controlDbPath: localDb,
			host: "stdio-client-host",
			input: child.stdout,
			output: child.stdin,
			signal: controller.signal,
			pollMs: 20,
		});
		try {
			await expect.poll(() => listRuntimeMailboxMessages(remoteDb), { timeout: 15_000 }).toHaveLength(1);
			await expect.poll(() => listRuntimeMailboxMessages(localDb)).toHaveLength(0);
			expect(
				takeRuntimeMailboxMessagesForDelivery(remoteDb, recipient, () => true).map((message) => message.body),
			).toEqual(["native relay message"]);
			await expect
				.poll(() => listSharedChannelMessagesAfter(remoteDb, 0))
				.toMatchObject([{ originHost: "stdio-client-host", body: "Restart /tmp/native-relay" }]);
			controller.abort();
			await protocol;
			child.stdin.end();
			expect(await exited, stderr).toBe(0);
		} finally {
			controller.abort();
			child.kill("SIGKILL");
			await protocol;
			await exited;
			rmSync(paths.tempDir, { recursive: true, force: true });
		}
	}, 20_000);
});
