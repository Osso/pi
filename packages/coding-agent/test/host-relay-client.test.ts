import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runSshRelayClient } from "../src/core/host-relay-client.ts";
import { enqueueStoredRuntimeMailboxMessage, listRuntimeMailboxMessages } from "../src/core/session-control-db.ts";

describe("SSH relay reconnect", () => {
	it("logs an outage, reconnects without losing queued messages, and stops its child", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-relay-ssh-"));
		const senderDb = join(directory, "sender.sqlite");
		const receiverDb = join(directory, "receiver.sqlite");
		const attempts = join(directory, "attempts");
		const argvPath = join(directory, "argv.json");
		const pidPath = join(directory, "peer-pid");
		const fixture = join(directory, "ssh.mjs");
		const moduleUrl = pathToFileURL(join(import.meta.dirname, "../src/core/host-relay.ts")).href;
		writeFileSync(
			fixture,
			`#!${process.execPath} --experimental-strip-types
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { runHostRelay } from ${JSON.stringify(moduleUrl)};
const path = ${JSON.stringify(attempts)};
const attempt = existsSync(path) ? Number(readFileSync(path, "utf8")) + 1 : 1;
writeFileSync(path, String(attempt));
writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
if (attempt === 1) { process.stderr.write("peer unavailable\\n"); process.exit(255); }
await runHostRelay({ controlDbPath: ${JSON.stringify(receiverDb)}, host: "agent-server", input: process.stdin, output: process.stdout, pollMs: 20 });
`,
			{ mode: 0o755 },
		);
		symlinkSync(fixture, join(directory, "ssh"));
		vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		enqueueStoredRuntimeMailboxMessage(senderDb, {
			kind: "message",
			recipientHost: "agent-server",
			recipient: { sessionId: "receiver", agentId: null },
			sender: { sessionId: "sender", agentId: null },
			storeRef: { sessionPath: "/sender/ssh.jsonl", messageId: "outage-message" },
			message: {
				id: "outage-message",
				kind: "message",
				status: "pending",
				fromAgentId: "main",
				toAgentId: "main",
				body: "survives SSH outage",
				createdAt: new Date().toISOString(),
			},
		});
		const controller = new AbortController();
		const task = runSshRelayClient(
			senderDb,
			{ peer: "server-alias", remoteCommand: "pi-custom relay serve" },
			controller.signal,
		);
		try {
			await expect.poll(() => log.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("peer unavailable");
			expect(listRuntimeMailboxMessages(senderDb)).toHaveLength(1);
			await expect.poll(() => listRuntimeMailboxMessages(receiverDb), { timeout: 5000 }).toHaveLength(1);
			await expect.poll(() => listRuntimeMailboxMessages(senderDb)).toHaveLength(0);
			expect(Number(readFileSync(attempts, "utf8"))).toBe(2);
			expect(JSON.parse(readFileSync(argvPath, "utf8"))).toEqual([
				"-o",
				"BatchMode=yes",
				"-o",
				"ServerAliveInterval=15",
				"server-alias",
				"pi-custom relay serve",
			]);
			controller.abort();
			await task;
			expect(() => process.kill(Number(readFileSync(pidPath, "utf8")), 0)).toThrow();
		} finally {
			controller.abort();
			await task;
			log.mockRestore();
			vi.unstubAllEnvs();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 10_000);
});
