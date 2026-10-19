import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHeadlessPaths } from "./headless-pi.ts";

function snapshotFiles(root: string): Record<string, string> {
	return Object.fromEntries(
		readdirSync(root, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => {
				const path = join(entry.parentPath, entry.name);
				return [relative(root, path), readFileSync(path).toString("base64")];
			}),
	);
}

function createSavedFixture(paths: ReturnType<typeof createHeadlessPaths>): string {
	const timestamp = "2026-10-19T00:00:00.000Z";
	const entries: object[] = [
		{ type: "session", version: 3, id: "terminal-export-fixture", timestamp, cwd: paths.workspaceDir },
	];
	for (let index = 0; index < 1200; index++) {
		entries.push({
			type: "message",
			id: `line-${index}`,
			parentId: index === 0 ? null : `line-${index - 1}`,
			timestamp,
			message: {
				role: "user",
				content: `HISTORY-${index.toString().padStart(4, "0")} ${"saved text ".repeat(12)}`,
				timestamp: 0,
			},
		});
	}
	entries.push({
		type: "message",
		id: "abandoned",
		parentId: "line-0",
		timestamp,
		message: { role: "user", content: "ABANDONED-BRANCH-NOT-EXPORTED", timestamp: 0 },
	});
	entries.push({
		type: "compaction",
		id: "compact",
		parentId: "line-1199",
		timestamp,
		firstKeptEntryId: "line-1100",
		summary: "Compacted history",
		tokensBefore: 200000,
	});
	entries.push({
		type: "message",
		id: "last",
		parentId: "compact",
		timestamp,
		message: { role: "user", content: "ACTIVE-BRANCH-LAST", timestamp: 0 },
	});
	const path = join(paths.sessionDir, "saved.jsonl");
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

async function runExport(paths: ReturnType<typeof createHeadlessPaths>, args: string[], useDefaultSessionDir = false) {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|NODE_OPTIONS/.test(key)),
	);
	const networkLog = join(paths.tempDir, "network-called");
	const preload = `import { writeFileSync } from 'node:fs'; globalThis.fetch = () => { writeFileSync(${JSON.stringify(networkLog)}, 'called'); throw new Error('Export must not access network'); };`;
	const child = spawn(
		"node",
		[
			"--experimental-strip-types",
			"--import",
			`data:text/javascript,${encodeURIComponent(preload)}`,
			join(import.meta.dirname, "..", "..", "src", "cli.ts"),
			...args,
		],
		{
			cwd: paths.workspaceDir,
			env: {
				...env,
				NODE_COMPILE_CACHE: join(paths.tempDir, "compile-cache"),
				PI_CODING_AGENT_DIR: paths.agentDir,
				PI_CODING_AGENT_STATE_DIR: paths.agentDir,
				PI_CODING_AGENT_SESSION_DIR: useDefaultSessionDir ? undefined : paths.sessionDir,
				COLORTERM: "truecolor",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.stdout.pause();
	const resume = setTimeout(() => child.stdout.resume(), 100);
	try {
		const code = await new Promise<number | null>((resolve, reject) => {
			const timeout = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error(`Export timed out: ${stderr}`));
			}, 15000);
			child.once("error", (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			child.once("close", (exitCode) => {
				clearTimeout(timeout);
				resolve(exitCode);
			});
		});
		return { code, stdout, stderr };
	} finally {
		clearTimeout(resume);
		if (child.exitCode === null) child.kill("SIGKILL");
	}
}

function installStartupTraps(paths: ReturnType<typeof createHeadlessPaths>) {
	mkdirSync(join(paths.agentDir, "extensions"));
	writeFileSync(
		join(paths.agentDir, "extensions", "trap.ts"),
		`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(paths.agentDir, "extension-called"))}, 'called'); throw new Error('Extension executed');`,
	);
	writeFileSync(join(paths.agentDir, "settings.json"), JSON.stringify({ theme: "light" }));
	writeFileSync(join(paths.agentDir, "models.json"), "not valid model registry JSON");
}

describe("read-only terminal export CLI", () => {
	it("SessionManager.list returns no sessions without creating a missing default directory", async () => {
		const paths = createHeadlessPaths();
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = paths.agentDir;
			const before = readdirSync(paths.agentDir, { recursive: true });
			expect(await SessionManager.list(paths.workspaceDir)).toEqual([]);
			expect(readdirSync(paths.agentDir, { recursive: true })).toEqual(before);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(paths.tempDir, { recursive: true, force: true });
		}
	});

	it.each(["path", "id"])(
		"flushes the entire saved branch by %s without startup side effects",
		async (lookup) => {
			const paths = createHeadlessPaths();
			try {
				const sessionPath = createSavedFixture(paths);
				installStartupTraps(paths);
				const before = snapshotFiles(paths.agentDir);
				const sessionsBefore = snapshotFiles(paths.sessionDir);
				const result = await runExport(paths, [
					"--export-terminal",
					lookup === "path" ? sessionPath : "terminal-export-fixture",
					"--export-columns",
					"100",
				]);
				expect(result.code, result.stderr).toBe(0);
				expect(result.stderr).toBe("");
				expect(result.stdout).toContain("\x1b[");
				const text = stripVTControlCharacters(result.stdout);
				expect(text.length).toBeGreaterThan(150000);
				expect(text.match(/HISTORY-\d{4}/g)).toHaveLength(1200);
				for (const marker of ["HISTORY-0000", "HISTORY-0600", "HISTORY-1199", "ACTIVE-BRANCH-LAST"]) {
					expect(text).toContain(marker);
				}
				expect(text).not.toContain("ABANDONED-BRANCH-NOT-EXPORTED");
				expect(result.stdout.endsWith("\n")).toBe(true);
				expect(snapshotFiles(paths.agentDir)).toEqual(before);
				expect(snapshotFiles(paths.sessionDir)).toEqual(sessionsBefore);
				expect(readdirSync(paths.tempDir)).not.toContain("network-called");
			} finally {
				rmSync(paths.tempDir, { recursive: true, force: true });
			}
		},
		30000,
	);

	it.each([false, true])(
		"default ID lookup does not create directories (saved=%s)",
		async (saved) => {
			const paths = createHeadlessPaths();
			try {
				if (saved) {
					const otherProjectDir = join(paths.agentDir, "sessions", "--other-project--");
					mkdirSync(otherProjectDir, { recursive: true });
					createSavedFixture({ ...paths, sessionDir: otherProjectDir });
				}
				const before = readdirSync(paths.agentDir, { recursive: true });
				const filesBefore = snapshotFiles(paths.agentDir);
				const result = await runExport(
					paths,
					["--export-terminal", "terminal-export-fixture", "--export-columns", "100"],
					true,
				);
				expect(result.code, result.stderr).toBe(saved ? 0 : 4);
				if (saved) expect(stripVTControlCharacters(result.stdout)).toContain("ACTIVE-BRANCH-LAST");
				expect(readdirSync(paths.agentDir, { recursive: true })).toEqual(before);
				expect(snapshotFiles(paths.agentDir)).toEqual(filesBefore);
			} finally {
				rmSync(paths.tempDir, { recursive: true, force: true });
			}
		},
		30000,
	);

	it.each([
		["--export-terminal", "missing-session", "--export-columns", "80"],
		["--export-terminal", "missing.jsonl", "--export-columns", "80"],
		["--export-terminal", "claude/external-id", "--export-columns", "80"],
		["--export-terminal", "missing-session"],
		["--export-terminal", "missing-session", "--export-columns", "0"],
	])(
		"reports invalid requests on stderr without changing saved state: %j",
		async (...args) => {
			const paths = createHeadlessPaths();
			try {
				installStartupTraps(paths);
				const before = snapshotFiles(paths.agentDir);
				const result = await runExport(paths, args);
				expect(result.code).toBe(args.length === 4 && args[1] === "missing-session" && args[3] === "80" ? 4 : 1);
				expect(result.stdout).toBe("");
				expect(result.stderr).toMatch(/Error:.*(session|export-columns|alias)/i);
				expect(snapshotFiles(paths.agentDir)).toEqual(before);
				expect(readdirSync(paths.sessionDir)).toEqual([]);
				expect(readdirSync(paths.tempDir)).not.toContain("network-called");
			} finally {
				rmSync(paths.tempDir, { recursive: true, force: true });
			}
		},
		30000,
	);
});
