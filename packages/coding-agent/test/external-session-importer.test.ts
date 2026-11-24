import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { importExternalSessionAlias } from "../src/core/external-session-importer.ts";
import { archiveSessionFile } from "../src/core/session-archive-storage.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";
import { readSessionTranscriptBytes } from "../src/core/session-transcript.ts";
import { assertDefined } from "./utilities.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tempDirs: string[] = [];

function createTempDir(): string {
	const tempSuffix = randomUUID();
	const dir = mkdirSync(join(tmpdir(), `pi-external-session-${tempSuffix}`), { recursive: true });
	if (dir === undefined) throw new Error("failed to create temp dir");
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function readJsonl(path: string): unknown[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as unknown);
}

function writeJsonl(path: string, entries: unknown[]): void {
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

async function runCli(args: string[], cwd: string, homeDir: string, agentDir: string): Promise<number | null> {
	return new Promise<number | null>((resolvePromise, reject) => {
		const child = spawn(process.execPath, [cliPath, ...args], {
			cwd,
			env: {
				...process.env,
				HOME: homeDir,
				[ENV_AGENT_DIR]: agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: "ignore",
		});
		child.on("error", reject);
		child.on("close", resolvePromise);
	});
}

describe("importExternalSessionAlias", () => {
	it("imports a Codex session alias into a Pi session", async () => {
		const homeDir = createTempDir();
		const projectDir = join(homeDir, "project");
		const sessionDir = join(homeDir, "sessions");
		const sessionId = "019de1a5-95a6-7793-a098-68abf8e21e9e";
		const codexDir = join(homeDir, ".codex", "sessions", "2026", "04", "30");
		mkdirSync(codexDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeJsonl(join(codexDir, `rollout-2026-04-30T22-46-58-${sessionId}.jsonl`), [
			{
				timestamp: "2026-05-01T03:46:59.100Z",
				type: "session_meta",
				payload: { id: sessionId, cwd: projectDir, model_provider: "openai" },
			},
			{
				timestamp: "2026-05-01T03:47:00.000Z",
				type: "response_item",
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
			},
			{
				timestamp: "2026-05-01T03:47:01.000Z",
				type: "response_item",
				payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
			},
		]);

		const imported = await importExternalSessionAlias(`codex/${sessionId}`, { homeDir, sessionDir });

		expect(imported).not.toBeUndefined();
		expect(assertDefined(imported).path).toBe(join(sessionDir, `codex-${sessionId}.jsonl`));
		const sessionManager = SessionManager.open(assertDefined(imported).path);
		expect(sessionManager.getCwd()).toBe(projectDir);
		expect(sessionManager.getSessionId()).toBe(`codex-${sessionId}`);
		expect(sessionManager.buildSessionContext().messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
	});

	it("takes a Codex session ID from the rollout file name when session_meta has none", async () => {
		const homeDir = createTempDir();
		const sessionDir = join(homeDir, "sessions");
		const sessionId = "11111111-2222-4333-8444-555555555555";
		const codexDir = join(homeDir, ".codex", "sessions", "2026", "04", "30");
		mkdirSync(codexDir, { recursive: true });
		writeJsonl(join(codexDir, `rollout-2026-04-30T22-46-58-${sessionId}.jsonl`), [
			{ type: "session_meta", payload: {} },
			{ type: "response_item", payload: { type: "message", role: "user", content: "hello" } },
		]);

		const imported = await importExternalSessionAlias(`codex/${sessionId}`, { homeDir, sessionDir });

		expect(assertDefined(imported).path).toBe(join(sessionDir, `codex-${sessionId}.jsonl`));
		expect(SessionManager.open(assertDefined(imported).path).getSessionId()).toBe(`codex-${sessionId}`);
	});

	it("imports a Claude Code session alias into a Pi session", async () => {
		const homeDir = createTempDir();
		const projectDir = join(homeDir, "project");
		const sessionDir = join(homeDir, "sessions");
		const sessionId = "11111111-2222-4333-8444-555555555555";
		const claudeDir = join(homeDir, ".claude", "projects", "-tmp-project");
		mkdirSync(claudeDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeJsonl(join(claudeDir, `${sessionId}.jsonl`), [
			{ type: "summary", summary: "Old summary", cwd: projectDir, sessionId },
			{
				type: "user",
				timestamp: "2026-05-01T03:47:00.000Z",
				cwd: projectDir,
				message: { role: "user", content: [{ type: "text", text: "hello claude" }] },
			},
			{
				type: "assistant",
				timestamp: "2026-05-01T03:47:01.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "hi claude" }] },
			},
		]);

		const imported = await importExternalSessionAlias(`claude/${sessionId}`, { homeDir, sessionDir });

		expect(imported).not.toBeUndefined();
		const entries = readJsonl(assertDefined(imported).path);
		expect(entries).toMatchObject([
			{ type: "session", id: `claude-${sessionId}`, cwd: projectDir },
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant" } },
		]);
	});

	it("leaves Claude Code sidechain records out of the imported conversation", async () => {
		const homeDir = createTempDir();
		const sessionId = "22222222-2222-4333-8444-555555555555";
		const claudeDir = join(homeDir, ".claude", "projects", "-tmp-project");
		mkdirSync(claudeDir, { recursive: true });
		const record = (uuid: string, role: string, text: string, isSidechain: boolean) => ({
			type: role,
			uuid,
			isSidechain,
			sessionId,
			message: { role, content: [{ type: "text", text }] },
		});
		writeJsonl(join(claudeDir, `${sessionId}.jsonl`), [
			record("u1", "user", "main prompt", false),
			record("s1", "user", "subagent task", true),
			record("s2", "assistant", "sidechain draft", true),
			record("a1", "assistant", "main answer", false),
		]);

		const imported = await importExternalSessionAlias(`claude/${sessionId}`, {
			homeDir,
			sessionDir: join(homeDir, "sessions"),
		});

		const texts = readJsonl(assertDefined(imported).path).flatMap((entry) => {
			const message = (entry as { message?: { content: { text: string }[] } }).message;
			return message ? message.content.map((block) => block.text) : [];
		});
		expect(texts).toEqual(["main prompt", "main answer"]);
	});

	it("reuses an existing imported session", async () => {
		const homeDir = createTempDir();
		const projectDir = join(homeDir, "project");
		const sessionDir = join(homeDir, "sessions");
		const sessionId = "reuse-session";
		const codexDir = join(homeDir, ".codex", "sessions");
		mkdirSync(codexDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeJsonl(join(codexDir, `rollout-2026-04-30T22-46-58-${sessionId}.jsonl`), [
			{ type: "session_meta", payload: { id: sessionId, cwd: projectDir } },
		]);

		const first = await importExternalSessionAlias(`codex/${sessionId}`, { homeDir, sessionDir });
		const second = await importExternalSessionAlias(`codex/${sessionId}`, { homeDir, sessionDir });

		expect(second?.path).toBe(first?.path);
	});

	it("reuses an archived imported session instead of importing over its Pi-only entries", async () => {
		const homeDir = createTempDir();
		const projectDir = join(homeDir, "project");
		const sessionDir = join(homeDir, "sessions");
		const sessionId = "reuse-archived";
		const codexDir = join(homeDir, ".codex", "sessions");
		mkdirSync(codexDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeJsonl(join(codexDir, `rollout-2026-04-30T22-46-58-${sessionId}.jsonl`), [
			{ type: "session_meta", payload: { id: sessionId, cwd: projectDir } },
		]);
		const first = assertDefined(await importExternalSessionAlias(`codex/${sessionId}`, { homeDir, sessionDir }));
		appendFileSync(
			first.path,
			`${JSON.stringify({ type: "custom", customType: "pi-only", id: "pi-only-entry", parentId: null, timestamp: "2026-05-01T00:00:00.000Z" })}\n`,
		);
		const archivedPath = archiveSessionFile(first.path);
		rmSync(first.path, { force: true });

		const second = await importExternalSessionAlias(`codex/${sessionId}`, { homeDir, sessionDir });

		expect(second?.path).toBe(first.path);
		expect(existsSync(first.path)).toBe(false);
		expect(readSessionTranscriptBytes(archivedPath).toString("utf8")).toContain("pi-only-entry");
	});

	it("resolves Codex aliases through the --session flag", async () => {
		const homeDir = createTempDir();
		const agentDir = join(homeDir, "agent");
		const projectDir = join(homeDir, "project");
		const sessionId = "cli-session";
		const codexDir = join(homeDir, ".codex", "sessions");
		mkdirSync(codexDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeJsonl(join(codexDir, `rollout-2026-04-30T22-46-58-${sessionId}.jsonl`), [
			{ type: "session_meta", payload: { id: sessionId, cwd: projectDir } },
		]);

		const code = await runCli(
			["--session", `codex/${sessionId}`, "--model", "missing-model", "-p", "hi"],
			projectDir,
			homeDir,
			agentDir,
		);
		const importedPath = join(getDefaultSessionDir(projectDir, agentDir), `codex-${sessionId}.jsonl`);

		expect(code).toBe(1);
		expect(readJsonl(importedPath)[0]).toMatchObject({ type: "session", id: `codex-${sessionId}` });
	});

	it("resolves Claude aliases through the --session flag", async () => {
		const homeDir = createTempDir();
		const agentDir = join(homeDir, "agent");
		const projectDir = join(homeDir, "project");
		const sessionId = "claude-cli-session";
		const claudeDir = join(homeDir, ".claude", "projects", "-tmp-project");
		mkdirSync(claudeDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeJsonl(join(claudeDir, `${sessionId}.jsonl`), [
			{ type: "user", cwd: projectDir, message: { role: "user", content: "hello" } },
		]);

		const code = await runCli(
			["--session", `claude/${sessionId}`, "--model", "missing-model", "-p", "hi"],
			projectDir,
			homeDir,
			agentDir,
		);
		const importedPath = join(getDefaultSessionDir(projectDir, agentDir), `claude-${sessionId}.jsonl`);

		expect(code).toBe(1);
		expect(readJsonl(importedPath)[0]).toMatchObject({ type: "session", id: `claude-${sessionId}` });
	});

	it("preserves explicit jsonl paths that start with external provider names", async () => {
		const homeDir = createTempDir();
		const agentDir = join(homeDir, "agent");
		const projectDir = join(homeDir, "project");
		const localSessionPath = join(projectDir, "codex", "local.jsonl");
		mkdirSync(join(projectDir, "codex"), { recursive: true });
		writeJsonl(localSessionPath, [
			{ type: "session", version: 3, id: "local-session", timestamp: "2026-05-01T03:47:00.000Z", cwd: projectDir },
		]);

		const code = await runCli(
			["--session", "codex/local.jsonl", "--model", "missing-model", "-p", "hi"],
			projectDir,
			homeDir,
			agentDir,
		);

		expect(code).toBe(1);
		expect(readJsonl(localSessionPath)[0]).toMatchObject({ type: "session", id: "local-session" });
	});
});
