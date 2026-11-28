import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	registerRuntimeMailboxListener,
	writeSessionGoal,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";
import { describeSession, inspectRemoteSession } from "../src/supervisor/inspect-session.ts";
import { pairHostRelays } from "./host-relay-pair.ts";

const INSPECTOR = "supervisor-session";
const narrationFixture = JSON.parse(
	readFileSync(new URL("./fixtures/anthropic-narration.json", import.meta.url), "utf8"),
) as { content: Array<{ type: "thinking"; thinking: string; thinkingSignature: string }> };
const TARGET = "worker-session";

function transcriptLine(message: Record<string, unknown>): string {
	return JSON.stringify({ type: "message", id: Math.random().toString(36), message });
}

/** A stopped session with a goal and a short transcript, as the target host stores it. */
function writeTargetSession(controlDbPath: string, dir: string): void {
	const sessionPath = join(dir, "worker.jsonl");
	writeFileSync(
		sessionPath,
		[
			JSON.stringify({ type: "session", id: TARGET, cwd: "/srv/worker" }),
			transcriptLine({ role: "user", content: "Migrate the billing table" }),
			transcriptLine({
				role: "assistant",
				content: [
					{ type: "text", text: "Reading the schema first." },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "schema.sql" } },
				],
			}),
			transcriptLine({
				role: "toolResult",
				toolName: "read",
				content: [{ type: "text", text: "CREATE TABLE bills" }],
			}),
			transcriptLine({ role: "assistant", content: narrationFixture.content }),
		].join("\n"),
	);
	const now = new Date().toISOString();
	writeSessionMetadata(controlDbPath, {
		sessionPath,
		id: TARGET,
		cwd: "/srv/worker",
		name: "billing migration",
		createdAt: now,
		modifiedAt: now,
		messageCount: 4,
		firstMessage: "Migrate the billing table",
	});
	writeSessionGoal(controlDbPath, sessionPath, JSON.stringify({ objective: "Migrate billing" }));
}

describe("inspect_session", () => {
	let tempDir: string;
	let inspectorDb: string;
	let targetDb: string;
	const stops: Array<() => void> = [];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-inspect-session-"));
		inspectorDb = join(tempDir, "inspector.sqlite");
		targetDb = join(tempDir, "target.sqlite");
	});

	afterEach(async () => {
		for (const stop of stops.splice(0)) stop();
		await new Promise((resolve) => setTimeout(resolve, 20));
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("describes a local session's cwd, goal, and transcript tail", () => {
		writeTargetSession(inspectorDb, tempDir);
		const text = describeSession(inspectorDb, TARGET);
		expect(text).toContain(`Session ${TARGET} on host ${hostname()} (billing migration)`);
		expect(text).toContain("cwd: /srv/worker");
		expect(text).toContain('goal: {"objective":"Migrate billing"}');
		expect(text).toContain("[user] Migrate the billing table");
		expect(text).toContain("[assistant] Reading the schema first.");
		expect(text).toContain('[tool call read] {"path":"schema.sql"}');
		expect(text).toContain("[tool result read] CREATE TABLE bills");
		const [privateThinking, narration] = narrationFixture.content;
		expect(text).toContain(`[assistant] ${narration.thinking.replace(/\s+/g, " ").slice(0, 200)}`);
		expect(text).not.toContain(privateThinking.thinking.replace(/\s+/g, " ").slice(0, 80));
		expect(describeSession(inspectorDb, "missing")).toBe(`No session missing on host ${hostname()}.`);
	});

	it("describes a stopped session on another host through the relay", async () => {
		writeTargetSession(targetDb, tempDir);
		registerRuntimeMailboxListener(inspectorDb, { sessionId: INSPECTOR, agentId: null }, process.pid);
		stops.push(
			pairHostRelays(
				{ controlDbPath: inspectorDb, host: "inspector-host" },
				{ controlDbPath: targetDb, host: "target-host" },
			),
		);

		const text = await inspectRemoteSession(
			inspectorDb,
			INSPECTOR,
			{ sessionId: TARGET, host: "target-host" },
			undefined,
		);

		expect(text).toContain("cwd: /srv/worker");
		expect(text).toContain("[user] Migrate the billing table");
	});
});
