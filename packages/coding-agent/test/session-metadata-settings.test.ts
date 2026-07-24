import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getControlDbPath,
	readSessionMetadata,
	type WritableSessionMetadata,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";

describe("session metadata settings", () => {
	let tempDir: string;
	let controlDbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-settings-"));
		controlDbPath = getControlDbPath(tempDir);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("persists model and thinking settings across metadata snapshots", () => {
		const sessionPath = "/tmp/session.jsonl";
		const initialMetadata: WritableSessionMetadata = {
			sessionPath,
			id: "session-1",
			cwd: "/repo",
			createdAt: "2026-07-24T00:00:00.000Z",
			modifiedAt: "2026-07-24T00:00:00.000Z",
			messageCount: 1,
			firstMessage: "first",
			allMessagesText: "first",
			modelProvider: "openai-codex",
			modelId: "gpt-5.6-sol",
			thinkingLevel: "medium",
		};
		writeSessionMetadata(controlDbPath, initialMetadata);

		writeSessionMetadata(controlDbPath, {
			...initialMetadata,
			modifiedAt: "2026-07-24T00:01:00.000Z",
			modelProvider: undefined,
			modelId: undefined,
			thinkingLevel: undefined,
		});

		const stored = readSessionMetadata(controlDbPath, sessionPath);
		expect(stored).toMatchObject({
			modelProvider: "openai-codex",
			modelId: "gpt-5.6-sol",
			thinkingLevel: "medium",
		});
	});
});
