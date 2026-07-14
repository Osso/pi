import { constants as bufferConstants } from "buffer";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	bootstrapMultiAgentAgent,
	consumeRuntimeMailboxMessageByStoreRef,
	enqueueRuntimeMailboxMessage,
	getControlDbPath,
	listNamedSessions,
	readMultiAgentState,
	readSessionGoal,
	readSessionMetadata,
	setNamedSession,
	upsertMultiAgentMailboxMessage,
	writeMultiAgentCounters,
	writeSessionMetadata,
} from "../../src/core/session-control-db.ts";
import { findMostRecentSession, loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array for non-existent file", () => {
		const entries = loadEntriesFromFile(join(tempDir, "nonexistent.jsonl"));
		expect(entries).toEqual([]);
	});

	it("returns empty array for empty file", () => {
		const file = join(tempDir, "empty.jsonl");
		writeFileSync(file, "");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for file without valid session header", () => {
		const file = join(tempDir, "no-header.jsonl");
		writeFileSync(file, '{"type":"message","id":"1"}\n');
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for malformed JSON", () => {
		const file = join(tempDir, "malformed.jsonl");
		writeFileSync(file, "not json\n");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("loads valid session file", () => {
		const file = join(tempDir, "valid.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it("skips malformed lines but keeps valid ones", () => {
		const file = join(tempDir, "mixed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
	});

	it("opens session files larger than Node's max string length", () => {
		const file = join(tempDir, "large.jsonl");
		writeFileSync(
			file,
			'{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);

		const fd = openSync(file, "r+");
		try {
			const newline = Buffer.from("\n");
			const stride = 16 * 1024 * 1024;
			for (let offset = stride; offset <= bufferConstants.MAX_STRING_LENGTH + stride; offset += stride) {
				writeSync(fd, newline, 0, newline.length, offset);
			}
		} finally {
			closeSync(fd);
		}

		appendFileSync(
			file,
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);

		const sessionManager = SessionManager.open(file, tempDir);
		expect(sessionManager.getSessionId()).toBe("abc");
		expect(sessionManager.getEntries()).toHaveLength(1);
		expect(sessionManager.buildSessionContext().messages).toEqual([{ role: "user", content: "hi", timestamp: 1 }]);
	});
});

describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns null for empty directory", () => {
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns null for non-existent directory", () => {
		expect(findMostRecentSession(join(tempDir, "nonexistent"))).toBeNull();
	});

	it("ignores non-jsonl files", () => {
		writeFileSync(join(tempDir, "file.txt"), "hello");
		writeFileSync(join(tempDir, "file.json"), "{}");
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("ignores jsonl files without valid session header", () => {
		writeFileSync(join(tempDir, "invalid.jsonl"), '{"type":"message"}\n');
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns single valid session file", () => {
		const file = join(tempDir, "session.jsonl");
		writeFileSync(file, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		expect(findMostRecentSession(tempDir)).toBe(file);
	});

	it("returns most recently modified session", async () => {
		const file1 = join(tempDir, "older.jsonl");
		const file2 = join(tempDir, "newer.jsonl");

		writeFileSync(file1, '{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		// Small delay to ensure different mtime
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(file2, '{"type":"session","id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = join(tempDir, "invalid.jsonl");
		const valid = join(tempDir, "valid.jsonl");

		writeFileSync(invalid, '{"type":"not-session"}\n');
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});

	it("filters most recent session by cwd", async () => {
		const projectA = join(tempDir, "project-a");
		const projectB = join(tempDir, "project-b");
		const fileA = join(tempDir, "a.jsonl");
		const fileB = join(tempDir, "b.jsonl");

		writeFileSync(
			fileA,
			`${JSON.stringify({ type: "session", id: "a", timestamp: "2025-01-01T00:00:00Z", cwd: projectA })}\n`,
		);
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(
			fileB,
			`${JSON.stringify({ type: "session", id: "b", timestamp: "2025-01-01T00:00:00Z", cwd: projectB })}\n`,
		);

		expect(findMostRecentSession(tempDir, projectA)).toBe(fileA);
		expect(findMostRecentSession(tempDir, projectB)).toBe(fileB);
	});
});

describe("SessionManager relocate", () => {
	let tempDir: string;
	let projectA: string;
	let projectB: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-relocate-test-${Date.now()}`);
		projectA = join(tempDir, "project-a");
		projectB = join(tempDir, "project-b");
		agentDir = join(tempDir, "agent");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function defaultSessionDir(cwd: string): string {
		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		return join(agentDir, "sessions", safePath);
	}

	it("moves a default-session-dir session to the target cwd storage and updates its header", () => {
		const sourceSessionDir = defaultSessionDir(projectA);
		const controlDbPath = getControlDbPath(agentDir);
		const session = SessionManager.create(projectA, sourceSessionDir, {
			isSubagent: true,
			subagentName: "worker",
		});
		session.setMetadataControlDbPath(controlDbPath);
		const sourceFile = session.getSessionFile();
		expect(sourceFile).toBeDefined();

		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "world" }],
			stopReason: "stop",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 2,
		});

		session.setSessionGoalJson(JSON.stringify({ objective: "keep goal" }));
		setNamedSession(controlDbPath, sourceFile!, "Keep name");
		bootstrapMultiAgentAgent(controlDbPath, sourceFile!, "agent_1", { id: "agent_1" });
		upsertMultiAgentMailboxMessage(controlDbPath, sourceFile!, "message_1", {
			messageId: "message_1",
			status: "pending",
		});
		writeMultiAgentCounters(controlDbPath, sourceFile!, {
			nextAgentNumber: 2,
			nextMessageNumber: 4,
		});
		enqueueRuntimeMailboxMessage(controlDbPath, {
			recipient: { sessionId: "recipient", agentId: "agent_1" },
			sender: { sessionId: "sender", agentId: null },
			kind: "message",
			storeRef: { sessionPath: sourceFile!, messageId: "message_1" },
		});
		session.relocate(projectB, agentDir);

		const movedFile = session.getSessionFile();
		expect(movedFile).toBe(join(defaultSessionDir(projectB), basename(sourceFile!)));
		expect(existsSync(sourceFile!)).toBe(false);
		expect(existsSync(movedFile!)).toBe(true);
		expect(session.getCwd()).toBe(projectB);

		const header = JSON.parse(readFileSync(movedFile!, "utf8").split("\n")[0]!) as { cwd: string };
		expect(header.cwd).toBe(projectB);
		expect(SessionManager.open(movedFile!).getCwd()).toBe(projectB);
		expect(readSessionMetadata(controlDbPath, sourceFile!)).toBeUndefined();
		const movedMetadata = readSessionMetadata(controlDbPath, movedFile!);
		expect(movedMetadata).toMatchObject({ isSubagent: true, subagentName: "worker" });
		expect(readSessionGoal(controlDbPath, movedFile!)).toBe(JSON.stringify({ objective: "keep goal" }));
		expect(listNamedSessions(controlDbPath)).toEqual([
			{ sessionPath: movedFile!, name: "Keep name", updatedAt: expect.any(String) },
		]);
		expect(readMultiAgentState(controlDbPath, sourceFile!)).toBeUndefined();
		expect(readMultiAgentState(controlDbPath, movedFile!)).toEqual({
			agents: [{ id: "agent_1" }],
			mailboxMessages: [
				{
					messageId: "message_1",
					recipientAgentId: "agent_1",
					recipientSessionId: "recipient",
					senderAgentId: null,
					senderSessionId: "sender",
					status: "pending",
				},
			],
			counters: { nextAgentNumber: 2, nextMessageNumber: 4 },
		});
		expect(
			consumeRuntimeMailboxMessageByStoreRef(controlDbPath, { sessionPath: sourceFile!, messageId: "message_1" }),
		).toBe(0);
		expect(
			consumeRuntimeMailboxMessageByStoreRef(controlDbPath, { sessionPath: movedFile!, messageId: "message_1" }),
		).toBe(1);
	});
});

describe("SessionManager custom flat session directory", () => {
	let tempDir: string;
	let projectA: string;
	let projectB: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		projectA = join(tempDir, "project-a");
		projectB = join(tempDir, "project-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createPersistedSession(
		cwd: string,
		label: string,
		options?: { controlDbPath?: string; isSubagent?: boolean; subagentName?: string },
	): string {
		const subagentOptions = options?.subagentName
			? { isSubagent: true, subagentName: options.subagentName }
			: { isSubagent: true };
		const session = options?.isSubagent
			? SessionManager.create(cwd, tempDir, subagentOptions)
			: SessionManager.create(cwd, tempDir);
		if (options?.controlDbPath) {
			session.setMetadataControlDbPath(options.controlDbPath);
		}
		session.appendMessage({ role: "user", content: label, timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `reply to ${label}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) {
			throw new Error("Expected persisted session file");
		}
		return sessionFile;
	}

	it("scopes current-folder APIs by cwd while listing all flat sessions", async () => {
		const sessionA = createPersistedSession(projectA, "from A");
		await new Promise((r) => setTimeout(r, 10));
		const sessionB = createPersistedSession(projectB, "from B");

		const currentA = await SessionManager.list(projectA, tempDir);
		expect(currentA.map((session) => session.path)).toEqual([sessionA]);

		const all = await SessionManager.listAll(tempDir);
		expect(new Set(all.map((session) => session.path))).toEqual(new Set([sessionA, sessionB]));

		const continuedA = SessionManager.continueRecent(projectA, tempDir);
		expect(continuedA.getSessionFile()).toBe(sessionA);
	});

	it("lists from sqlite metadata even when metadata paths do not match session files", async () => {
		const controlDbPath = getControlDbPath(tempDir);
		const sessionA = createPersistedSession(projectA, "from A");
		createPersistedSession(projectA, "from B");
		writeSessionMetadata(controlDbPath, {
			sessionPath: sessionA,
			id: "metadata-a",
			cwd: projectA,
			name: undefined,
			parentSessionPath: undefined,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:00:00.000Z",
			messageCount: 1,
			firstMessage: "metadata A",
			allMessagesText: "metadata A",
		});
		writeSessionMetadata(controlDbPath, {
			sessionPath: join(tempDir, "missing.jsonl"),
			id: "metadata-missing",
			cwd: projectA,
			name: undefined,
			parentSessionPath: undefined,
			createdAt: "2026-01-02T00:00:00.000Z",
			modifiedAt: "2026-01-02T00:00:00.000Z",
			messageCount: 1,
			firstMessage: "metadata missing",
			allMessagesText: "metadata missing",
		});

		const currentA = await SessionManager.list(projectA, tempDir, undefined, controlDbPath);

		expect(currentA.map((entry) => entry.path)).toEqual([join(tempDir, "missing.jsonl"), sessionA]);
		expect(currentA.map((entry) => entry.firstMessage)).toEqual(["metadata missing", "metadata A"]);
	});

	it("updates sqlite metadata incrementally on messages and skips writes for custom entries", () => {
		const controlDbPath = getControlDbPath(tempDir);
		const session = SessionManager.create(projectA, tempDir);
		session.setMetadataControlDbPath(controlDbPath);
		session.appendMessage({ role: "user", content: "first prompt", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "first reply" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		expect(readSessionMetadata(controlDbPath, sessionFile)).toMatchObject({
			allMessagesText: "first prompt first reply",
			messageCount: 2,
		});

		const sentinel = readSessionMetadata(controlDbPath, sessionFile);
		if (!sentinel) throw new Error("Expected session metadata");
		writeSessionMetadata(controlDbPath, { ...sentinel, firstMessage: "sentinel", allMessagesText: "sentinel" });
		session.appendCustomEntry("multi-agent-test", { payload: "snapshot" });

		expect(readSessionMetadata(controlDbPath, sessionFile)).toMatchObject({
			allMessagesText: "sentinel",
			firstMessage: "sentinel",
		});

		session.appendMessage({ role: "user", content: "second prompt", timestamp: 3 });

		expect(readSessionMetadata(controlDbPath, sessionFile)).toMatchObject({
			allMessagesText: "first prompt first reply second prompt",
			firstMessage: "first prompt",
			messageCount: 3,
		});
	});

	it("preserves persisted subagent metadata when a session is reopened with sqlite metadata", () => {
		const controlDbPath = getControlDbPath(tempDir);
		const session = SessionManager.create(projectA, tempDir, {
			isSubagent: true,
			subagentName: "researcher",
		});
		session.setMetadataControlDbPath(controlDbPath);
		session.appendMessage({ role: "user", content: "subagent prompt", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "subagent reply" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");

		const reopened = SessionManager.open(sessionFile, tempDir);
		reopened.setMetadataControlDbPath(controlDbPath);

		expect(reopened.isSubagentSession()).toBe(true);
		expect(reopened.getSubagentName()).toBe("researcher");
		expect(readSessionMetadata(controlDbPath, sessionFile)).toMatchObject({
			isSubagent: true,
			subagentName: "researcher",
		});
	});

	it("excludes subagent sessions from current-folder resume lists backed by sqlite metadata", async () => {
		const controlDbPath = getControlDbPath(tempDir);
		const mainSession = createPersistedSession(projectA, "main prompt", { controlDbPath });
		const subagentSessionFile = createPersistedSession(projectA, "subagent prompt", {
			controlDbPath,
			isSubagent: true,
			subagentName: "researcher",
		});

		const currentA = await SessionManager.list(projectA, tempDir, undefined, controlDbPath);

		expect(currentA.map((entry) => entry.path)).toEqual([mainSession]);
		expect(currentA.map((entry) => entry.path)).not.toContain(subagentSessionFile);
	});

	it("excludes subagent sessions from all-project resume lists backed by sqlite metadata", async () => {
		const controlDbPath = getControlDbPath(tempDir);
		const mainSession = createPersistedSession(projectA, "main prompt", { controlDbPath });
		const otherProjectSession = createPersistedSession(projectB, "other project prompt", { controlDbPath });
		const subagentSessionFile = createPersistedSession(projectB, "subagent prompt", {
			controlDbPath,
			isSubagent: true,
			subagentName: "researcher",
		});

		const all = await SessionManager.listAll(tempDir, undefined, controlDbPath);
		const listedPaths = new Set(all.map((entry) => entry.path));

		expect(listedPaths).toEqual(new Set([mainSession, otherProjectSession]));
		expect(listedPaths.has(subagentSessionFile)).toBe(false);
	});

	it("excludes known subagent sessions when incomplete sqlite metadata falls back to file scanning", async () => {
		const controlDbPath = getControlDbPath(tempDir);
		const mainSession = createPersistedSession(projectA, "main prompt");
		const subagentSessionFile = createPersistedSession(projectA, "subagent prompt", {
			controlDbPath,
			isSubagent: true,
			subagentName: "researcher",
		});

		const currentA = await SessionManager.list(projectA, tempDir, undefined, controlDbPath);

		expect(currentA.map((entry) => entry.path)).toEqual([mainSession]);
		expect(currentA.map((entry) => entry.path)).not.toContain(subagentSessionFile);
	});

	it("refreshes known subagent metadata when fallback scanning hides it from resume lists", async () => {
		const controlDbPath = getControlDbPath(tempDir);
		createPersistedSession(projectA, "main prompt");
		const subagentSessionFile = createPersistedSession(projectA, "subagent prompt", {
			controlDbPath,
			isSubagent: true,
			subagentName: "researcher",
		});
		const subagentMetadata = readSessionMetadata(controlDbPath, subagentSessionFile);
		if (!subagentMetadata) throw new Error("Expected subagent metadata");
		writeSessionMetadata(controlDbPath, {
			...subagentMetadata,
			messageCount: 0,
			firstMessage: "stale prompt",
			allMessagesText: "stale prompt",
		});

		const currentA = await SessionManager.list(projectA, tempDir, undefined, controlDbPath);
		const refreshedSubagentMetadata = readSessionMetadata(controlDbPath, subagentSessionFile);

		expect(currentA.map((entry) => entry.path)).not.toContain(subagentSessionFile);
		expect(refreshedSubagentMetadata).toMatchObject({
			isSubagent: true,
			subagentName: "researcher",
			messageCount: 2,
			firstMessage: "subagent prompt",
			allMessagesText: "subagent prompt reply to subagent prompt",
		});
	});

	it("writes session metadata to sqlite and lists from it", async () => {
		const controlDbPath = getControlDbPath(tempDir);
		const session = SessionManager.create(projectA, tempDir);
		session.setMetadataControlDbPath(controlDbPath);
		session.appendMessage({ role: "user", content: "fast listing prompt", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "fast listing reply" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");

		expect(readSessionMetadata(controlDbPath, sessionFile)).toMatchObject({
			sessionPath: sessionFile,
			id: session.getSessionId(),
			cwd: projectA,
			messageCount: 2,
			firstMessage: "fast listing prompt",
			allMessagesText: "fast listing prompt fast listing reply",
		});

		writeFileSync(sessionFile, "not jsonl metadata path proves sqlite listing is used\n");
		const currentA = await SessionManager.list(projectA, tempDir, undefined, controlDbPath);

		expect(currentA.map((entry) => entry.path)).toEqual([sessionFile]);
		expect(currentA[0]).toMatchObject({ firstMessage: "fast listing prompt" });
	});
});

describe("SessionManager.setSessionFile with corrupted files", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("truncates and rewrites empty file with valid header", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		const sm = SessionManager.open(emptyFile, tempDir);

		// Should have created a new session with valid header
		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");

		// File should now contain a valid header
		const content = readFileSync(emptyFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.id).toBe(sm.getSessionId());
	});

	it("throws and preserves non-empty file without valid header", () => {
		const noHeaderFile = join(tempDir, "no-header.jsonl");
		const originalContent =
			'{"type":"message","id":"abc","parentId":"orphaned","timestamp":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"test"}}\n';
		writeFileSync(noHeaderFile, originalContent);

		expect(() => SessionManager.open(noHeaderFile, tempDir)).toThrow(
			`Session file is not a valid pi session: ${noHeaderFile}`,
		);
		expect(readFileSync(noHeaderFile, "utf-8")).toBe(originalContent);
	});

	it("throws and preserves non-session JSONL files", () => {
		const nonSessionFile = join(tempDir, "not-a-session.log");
		const originalContent = '{"type":"event","data":"not a session"}\n';
		writeFileSync(nonSessionFile, originalContent);

		expect(() => SessionManager.open(nonSessionFile, tempDir)).toThrow(
			`Session file is not a valid pi session: ${nonSessionFile}`,
		);
		expect(readFileSync(nonSessionFile, "utf-8")).toBe(originalContent);
	});

	it("preserves explicit session file path when recovering from corrupted file", () => {
		const explicitPath = join(tempDir, "my-session.jsonl");
		writeFileSync(explicitPath, "");

		const sm = SessionManager.open(explicitPath, tempDir);

		// The session file path should be preserved
		expect(sm.getSessionFile()).toBe(explicitPath);
	});

	it("subsequent loads of initialized empty file work correctly", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		const sm1 = SessionManager.open(emptyFile, tempDir);
		const sessionId = sm1.getSessionId();

		const sm2 = SessionManager.open(emptyFile, tempDir);
		expect(sm2.getSessionId()).toBe(sessionId);
		expect(sm2.getHeader()?.type).toBe("session");
	});
});
