import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { importExternalSessionAlias } from "../src/core/external-session-importer.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";

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

		const imported = await importExternalSessionAlias(`codex/${sessionId}`, { homeDir });

		expect(imported).not.toBeUndefined();
		const sessionManager = SessionManager.open(imported!.path);
		expect(sessionManager.getCwd()).toBe(projectDir);
		expect(sessionManager.getSessionId()).toBe(`codex-${sessionId}`);
		expect(sessionManager.buildSessionContext().messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
	});

	it("imports a Claude Code session alias into a Pi session", async () => {
		const homeDir = createTempDir();
		const projectDir = join(homeDir, "project");
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

		const imported = await importExternalSessionAlias(`claude/${sessionId}`, { homeDir });

		expect(imported).not.toBeUndefined();
		const entries = readJsonl(imported!.path);
		expect(entries).toMatchObject([
			{ type: "session", id: `claude-${sessionId}`, cwd: projectDir },
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant" } },
		]);
	});

	it("reuses an existing imported session", async () => {
		const homeDir = createTempDir();
		const projectDir = join(homeDir, "project");
		const sessionId = "reuse-session";
		const codexDir = join(homeDir, ".codex", "sessions");
		mkdirSync(codexDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeJsonl(join(codexDir, `rollout-2026-04-30T22-46-58-${sessionId}.jsonl`), [
			{ type: "session_meta", payload: { id: sessionId, cwd: projectDir } },
		]);

		const first = await importExternalSessionAlias(`codex/${sessionId}`, { homeDir });
		const second = await importExternalSessionAlias(`codex/${sessionId}`, { homeDir });

		expect(second?.path).toBe(first?.path);
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
