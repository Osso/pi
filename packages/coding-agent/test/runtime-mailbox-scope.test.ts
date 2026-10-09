import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	listRuntimeMailboxMessages,
	listRuntimeMailboxMessagesForSession,
	type RuntimeMailboxMessage,
} from "../src/core/session-control-db.ts";
import { createSqliteDatabase, type SqliteDatabase } from "../src/core/sqlite.ts";

const ownSessionPath = "/sessions/own ' ? %.jsonl";
const updatedAt = "2026-10-08T12:00:00.000Z";
const hasBun = spawnSync("bun", ["--version"], { encoding: "utf8", timeout: 10_000 }).status === 0;

function insertMessage(
	db: SqliteDatabase,
	sessionPath: string,
	messageId: string,
	data: Record<string, unknown>,
): number {
	return Number(
		db
			.prepare(
				"INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at) VALUES (?, ?, ?, ?)",
			)
			.run(sessionPath, messageId, JSON.stringify({ createdAt: updatedAt, ...data }), updatedAt).lastInsertRowid,
	);
}

function seedMailbox(controlDbPath: string, unrelatedBodySize = 32): RuntimeMailboxMessage[] {
	listRuntimeMailboxMessages(controlDbPath);
	const db = createSqliteDatabase(controlDbPath);
	try {
		db.exec("BEGIN");
		const kinds = ["system", "message", "ask", "reply", "steer", "parent_request"] as const;
		const statuses = ["delivered", "pending", "failed", "claimed"] as const;
		const own = kinds.map((kind, index): RuntimeMailboxMessage => {
			const messageId = `own-${kinds.length - index}`;
			const status = statuses[index % statuses.length];
			const message = {
				body: `own body ${index}`,
				claimedAt: status === "claimed" ? "2026-10-08T11:30:00.000Z" : undefined,
				createdAt: "2026-10-08T11:00:00.000Z",
				deliveredAt: status === "delivered" ? "2026-10-08T11:45:00.000Z" : undefined,
				error: status === "failed" ? "concrete delivery failure" : undefined,
				fileRefs: index === 0 ? [{ path: "/tmp/result.txt", label: "result" }] : undefined,
				kind,
				recipient: {
					agentId: index % 2 === 0 ? null : `recipient-${index}`,
					sessionId: `recipient-session-${index}`,
				},
				sender: { agentId: index % 2 === 0 ? `sender-${index}` : null, sessionId: `sender-session-${index}` },
				status,
				targetCheckpoint: kind === "steer" ? ("after_tool_result" as const) : undefined,
				updatedAt,
			};
			const id = insertMessage(db, ownSessionPath, messageId, {
				...message,
				fromAgentId: message.sender.agentId ?? "main",
				id: messageId,
				recipientAgentId: message.recipient.agentId,
				recipientSessionId: message.recipient.sessionId,
				revision: index + 10,
				senderAgentId: message.sender.agentId,
				senderSessionId: message.sender.sessionId,
				toAgentId: message.recipient.agentId ?? "main",
			});
			return { ...message, id, storeRef: { messageId, sessionPath: ownSessionPath } };
		});
		for (let index = 0; index < 128; index += 1) {
			insertMessage(db, `/sessions/unrelated-${index}.jsonl`, `unrelated-${index}`, {
				body: "x".repeat(unrelatedBodySize),
				kind: "system",
				recipientAgentId: own[0].recipient.agentId,
				recipientSessionId: own[0].recipient.sessionId,
				senderAgentId: own[0].sender.agentId,
				senderSessionId: own[0].sender.sessionId,
				status: "delivered",
			});
		}
		insertMessage(db, ownSessionPath, "unaddressed", { body: "local only", kind: "message", status: "pending" });
		db.exec("COMMIT");
		return own;
	} finally {
		db.close();
	}
}

describe("session-scoped runtime mailbox listing", () => {
	let directory: string;
	let controlDbPath: string;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(updatedAt);
		directory = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-scope-"));
		controlDbPath = join(directory, "control.sqlite");
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(directory, { recursive: true, force: true });
	});

	it("preserves canonical messages, every status and recipient, in insertion order", () => {
		const own = seedMailbox(controlDbPath);
		expect(listRuntimeMailboxMessagesForSession).toBeTypeOf("function");
		expect(listRuntimeMailboxMessagesForSession(controlDbPath, ownSessionPath)).toEqual(own);
		expect(listRuntimeMailboxMessagesForSession(controlDbPath, "/sessions/missing.jsonl")).toEqual([]);
		expect(listRuntimeMailboxMessagesForSession(controlDbPath, "")).toEqual([]);
		const global = listRuntimeMailboxMessages(controlDbPath);
		expect(global).toHaveLength(134);
		expect(global.filter((message) => message.storeRef.sessionPath === ownSessionPath)).toEqual(own);
		expect(global[6]).toMatchObject({ createdAt: updatedAt, updatedAt });
	});

	it("excludes malformed addressed unrelated rows before canonical payload parsing", () => {
		const own = seedMailbox(controlDbPath);
		const db = createSqliteDatabase(controlDbPath);
		try {
			insertMessage(db, "/sessions/malformed-unrelated.jsonl", "malformed", {
				body: 42,
				kind: "system",
				recipientSessionId: "recipient-session-0",
				status: "pending",
			});
		} finally {
			db.close();
		}
		expect(listRuntimeMailboxMessagesForSession(controlDbPath, ownSessionPath)).toEqual(own);
		expect(() => listRuntimeMailboxMessages(controlDbPath)).toThrow(/Invalid persisted body.*malformed-unrelated/);
	});

	it("still reports malformed addressed rows in the requested session", () => {
		seedMailbox(controlDbPath);
		const db = createSqliteDatabase(controlDbPath);
		try {
			insertMessage(db, ownSessionPath, "malformed-own", {
				body: 42,
				kind: "message",
				recipientSessionId: "recipient-session-0",
				status: "failed",
			});
		} finally {
			db.close();
		}
		expect(() => listRuntimeMailboxMessagesForSession(controlDbPath, ownSessionPath)).toThrow(
			/Invalid persisted body.*malformed-own/,
		);
	});

	it.runIf(process.platform === "linux" && hasBun)(
		"keeps cold Bun lookup logical reads below 1 MiB with 8 MiB unrelated history",
		() => {
			const own = seedMailbox(controlDbPath, 64 * 1024);
			expect(statSync(controlDbPath).size).toBeGreaterThan(8 * 1024 * 1024);
			const scriptPath = join(directory, "measure-reads.ts");
			const moduleUrl = pathToFileURL(resolve(import.meta.dirname, "../src/core/session-control-db.ts")).href;
			writeFileSync(
				scriptPath,
				`import { readFileSync } from "node:fs";
import { listRuntimeMailboxMessages, listRuntimeMailboxMessagesForSession } from ${JSON.stringify(moduleUrl)};
Date.now = () => Date.parse(${JSON.stringify(updatedAt)});
function rchar(path: string): number {
	const match = /^rchar:\\s+(\\d+)$/m.exec(readFileSync(path, "utf8"));
	if (!match) throw new Error("Missing kernel rchar counter at " + path);
	return Number(match[1]);
}
const processBefore = rchar("/proc/self/io");
const threadBefore = rchar("/proc/thread-self/io");
const messages = process.argv[4] === "global"
	? listRuntimeMailboxMessages(process.argv[2]).filter(message => message.storeRef.sessionPath === process.argv[3])
	: listRuntimeMailboxMessagesForSession(process.argv[2], process.argv[3]);
const threadReadBytes = rchar("/proc/thread-self/io") - threadBefore;
const processReadBytes = rchar("/proc/self/io") - processBefore;
console.log(JSON.stringify({ messages, processReadBytes, threadReadBytes }));
`,
			);
			for (const mode of ["scoped", "global"]) {
				const result = spawnSync("bun", [scriptPath, controlDbPath, ownSessionPath, mode], {
					encoding: "utf8",
					timeout: 20_000,
				});
				expect(result.error).toBeUndefined();
				expect(result.status, result.stderr || result.stdout).toBe(0);
				const measured = JSON.parse(result.stdout) as {
					messages: RuntimeMailboxMessage[];
					processReadBytes: number;
					threadReadBytes: number;
				};
				expect(measured.messages).toEqual(JSON.parse(JSON.stringify(own)));
				console.info(
					`Bun ${mode} logical reads: ${JSON.stringify(measured, (key, value) => (key === "messages" ? undefined : value))}`,
				);
				if (mode === "scoped") {
					expect(measured.threadReadBytes).toBeLessThan(1024 * 1024);
					expect(measured.processReadBytes).toBeLessThan(1024 * 1024);
				} else {
					expect(measured.threadReadBytes).toBeGreaterThan(8 * 1024 * 1024);
					expect(measured.processReadBytes).toBeGreaterThan(8 * 1024 * 1024);
				}
			}
		},
	);
});
