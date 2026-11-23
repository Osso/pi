import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const assistantReply: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "reply" }],
	api: "faux",
	provider: "faux",
	model: "faux",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 2,
};

/** Text of each message in the reopened session context, in order. */
function reopenedTexts(file: string): string[] {
	return SessionManager.open(file)
		.buildSessionContext()
		.messages.map((message) => {
			if (!("content" in message)) return message.role;
			const { content } = message;
			return typeof content === "string"
				? content
				: content.map((part) => (part.type === "text" ? part.text : "")).join("");
		});
}

describe("SessionManager append after an interrupted write", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-partial-line-"));
		const session = SessionManager.create(dir, join(dir, "sessions"));
		session.appendMessage({ role: "user", content: "one", timestamp: 1 });
		session.appendMessage(assistantReply);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("session was not persisted");
		file = sessionFile;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("drops a partial last line instead of gluing the next entries onto it", () => {
		appendFileSync(file, '{"type":"message","id":"partial","parentId":');

		const resumed = SessionManager.open(file);
		resumed.appendMessage({ role: "user", content: "two", timestamp: 3 });
		resumed.appendMessage({ role: "user", content: "three", timestamp: 4 });

		expect(reopenedTexts(file)).toEqual(["one", "reply", "two", "three"]);
		expect(readFileSync(file, "utf8")).not.toContain('"partial"');
	});

	it("keeps a complete last entry whose newline was not written", () => {
		const resumed = SessionManager.open(file);
		resumed.appendMessage({ role: "user", content: "two", timestamp: 3 });
		const content = readFileSync(file, "utf8");
		rmSync(file);
		appendFileSync(file, content.slice(0, -1));

		const resumedAgain = SessionManager.open(file);
		resumedAgain.appendMessage({ role: "user", content: "three", timestamp: 4 });

		expect(reopenedTexts(file)).toEqual(["one", "reply", "two", "three"]);
	});

	it("drops a partial last line when the resumed session is relocated before its next append", () => {
		const agentDir = join(dir, "agent");
		const defaultDir = (cwd: string) =>
			join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
		const projectA = join(dir, "project-a");
		const projectB = join(dir, "project-b");
		const session = SessionManager.create(projectA, defaultDir(projectA));
		session.appendMessage({ role: "user", content: "one", timestamp: 1 });
		session.appendMessage(assistantReply);
		const sourceFile = session.getSessionFile();
		if (!sourceFile) throw new Error("session was not persisted");
		appendFileSync(sourceFile, '{"type":"message","id":"partial","parentId":');

		const resumed = SessionManager.open(sourceFile, defaultDir(projectA));
		resumed.relocate(projectB, agentDir);
		resumed.appendMessage({ role: "user", content: "two", timestamp: 3 });
		const movedFile = resumed.getSessionFile();
		if (!movedFile) throw new Error("relocated session has no file");

		expect(movedFile).not.toBe(sourceFile);
		expect(reopenedTexts(movedFile)).toEqual(["one", "reply", "two"]);
	});

	it("leaves the file unchanged when it is only opened", () => {
		appendFileSync(file, '{"type":"message","id":"partial"');
		const before = readFileSync(file, "utf8");

		SessionManager.open(file).buildSessionContext();

		expect(readFileSync(file, "utf8")).toBe(before);
	});
});
