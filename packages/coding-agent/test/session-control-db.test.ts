import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claimLatestIncomingMessage,
	completeIncomingMessage,
	enqueueIncomingMessage,
	getControlDbPath,
	listNamedSessions,
	readIncomingMessageStatus,
	readLastMessage,
	removeNamedSession,
	setNamedSession,
	writeLastMessage,
} from "../src/core/session-control-db.ts";

describe("session control DB", () => {
	let tempDir: string;
	let controlDbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-control-"));
		controlDbPath = getControlDbPath(tempDir);
	});

	afterEach(() => {
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("stores control state next to the session transcript", () => {
		expect(controlDbPath).toBe(join(tempDir, "control.sqlite"));
	});

	it("claims only the latest pending incoming message", () => {
		enqueueIncomingMessage(controlDbPath, "older prompt");
		enqueueIncomingMessage(controlDbPath, "newer prompt");

		const claimed = claimLatestIncomingMessage(controlDbPath);

		expect(claimed?.content).toBe("newer prompt");
		expect(claimLatestIncomingMessage(controlDbPath)).toBeUndefined();
	});

	it("allows claimed incoming messages to be completed", () => {
		enqueueIncomingMessage(controlDbPath, "run this");
		const claimed = claimLatestIncomingMessage(controlDbPath);

		expect(claimed).toBeDefined();
		completeIncomingMessage(controlDbPath, claimed!.id);

		expect(readIncomingMessageStatus(controlDbPath, claimed!.id)).toBe("completed");
		expect(claimLatestIncomingMessage(controlDbPath)).toBeUndefined();
	});

	it("keeps only the latest assistant message", () => {
		writeLastMessage(controlDbPath, { role: "assistant", content: "first answer" });
		writeLastMessage(controlDbPath, { role: "assistant", content: "second answer" });

		expect(readLastMessage(controlDbPath)).toMatchObject({
			role: "assistant",
			content: "second answer",
		});
	});

	it("stores and removes named sessions", () => {
		setNamedSession(controlDbPath, "/tmp/session-a.jsonl", "Alpha");
		setNamedSession(controlDbPath, "/tmp/session-b.jsonl", "Beta");
		setNamedSession(controlDbPath, "/tmp/session-a.jsonl", "Alpha renamed");

		const namedSessions = listNamedSessions(controlDbPath)
			.map((session) => [session.sessionPath, session.name])
			.sort(([left], [right]) => left.localeCompare(right));
		expect(namedSessions).toEqual([
			["/tmp/session-a.jsonl", "Alpha renamed"],
			["/tmp/session-b.jsonl", "Beta"],
		]);

		removeNamedSession(controlDbPath, "/tmp/session-a.jsonl");

		expect(listNamedSessions(controlDbPath).map((session) => [session.sessionPath, session.name])).toEqual([
			["/tmp/session-b.jsonl", "Beta"],
		]);
	});
});
