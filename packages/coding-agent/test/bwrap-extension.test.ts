import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildBwrapInvocation,
	createBwrapRunnerCommand,
	createBwrapRunnerEnvironment,
	resolveBwrapSandboxProfile,
	runBwrapAvailabilityCheck,
} from "../extensions/bwrap/src/backend.ts";
import bwrapExtension from "../extensions/bwrap/src/index.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolGate } from "../src/index.ts";

const FS_WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "../extensions/bwrap/src/fs-worker.cjs");
const canExecuteBwrap =
	spawnSync(
		"bwrap",
		[
			"--unshare-all",
			"--share-net",
			"--ro-bind",
			"/usr",
			"/usr",
			"--ro-bind",
			"/bin",
			"/bin",
			"--ro-bind",
			"/lib",
			"/lib",
			"--ro-bind",
			"/lib64",
			"/lib64",
			"--ro-bind",
			"/etc",
			"/etc",
			"--dev",
			"/dev",
			"--proc",
			"/proc",
			"--",
			"/usr/bin/true",
		],
		{ encoding: "utf8" },
	).status === 0;

function createBwrapHarness(bwrapCommand = "/definitely/missing/bwrap") {
	const toolGates: ToolGate[] = [];
	const api = {
		on() {},
		registerCommand() {},
		registerTool() {},
		registerToolGate(gate: ToolGate) {
			toolGates.push(gate);
		},
	} as unknown as ExtensionAPI;
	bwrapExtension(api, { bwrapCommand });
	return { toolGates };
}

function createContext(settingsManager: SettingsManager): ExtensionContext {
	return { cwd: "/repo", settingsManager } as unknown as ExtensionContext;
}

function createToolCallEvent(toolName: string = "read"): ToolCallEvent {
	return {
		bypassPermissions: false,
		input: { path: "file.txt" },
		toolCallId: "tool-call-1",
		toolName,
		type: "tool_call",
	};
}

describe("bwrap sandbox backend", () => {
	let tempDir: string;
	let homeDir: string;
	let workspaceDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-bwrap-test-"));
		homeDir = join(tempDir, "home");
		workspaceDir = join(tempDir, "workspace");
		mkdirSync(join(homeDir, ".ssh"), { recursive: true });
		mkdirSync(join(homeDir, ".aws"), { recursive: true });
		mkdirSync(join(homeDir, ".gnupg"), { recursive: true });
		mkdirSync(join(homeDir, ".config"), { recursive: true });
		mkdirSync(workspaceDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("mounts required runtime paths instead of host root, clears env, fakes HOME/tmp, and mounts workspace read-only", () => {
		const invocation = buildBwrapInvocation({
			bwrapCommand: "bwrap",
			cwd: workspaceDir,
			homeDir,
			profile: "read-only",
			command: ["/bin/sh", "-lc", "true"],
		});

		expect(invocation.argv).not.toEqual(expect.arrayContaining(["--ro-bind", "/", "/"]));
		expect(invocation.argv).toEqual(
			expect.arrayContaining([
				"--clearenv",
				"--ro-bind",
				"/usr",
				"/usr",
				"--ro-bind",
				"/etc",
				"/etc",
				"--tmpfs",
				"/tmp",
				"--dir",
				"/tmp/pi-home",
				"--setenv",
				"HOME",
				"/tmp/pi-home",
				"--ro-bind",
				workspaceDir,
				workspaceDir,
			]),
		);
		for (const forbiddenPath of ["/home", "/syncthing", "/run", "/var"]) {
			expect(invocation.argv).not.toEqual(expect.arrayContaining(["--ro-bind", forbiddenPath, forbiddenPath]));
			expect(invocation.argv).not.toEqual(expect.arrayContaining(["--bind", forbiddenPath, forbiddenPath]));
		}
		expect(invocation.argv.slice(-3)).toEqual(["/bin/sh", "-lc", "true"]);
	});

	it("mounts the workspace writable for workspace-write", () => {
		const invocation = buildBwrapInvocation({
			bwrapCommand: "bwrap",
			cwd: workspaceDir,
			homeDir,
			profile: "workspace-write",
			command: ["/bin/sh", "-lc", "true"],
		});

		const workspaceMountIndex = invocation.argv.findIndex(
			(_value, index, argv) => argv[index + 1] === workspaceDir && argv[index + 2] === workspaceDir,
		);
		expect(invocation.argv.slice(workspaceMountIndex, workspaceMountIndex + 3)).toEqual([
			"--bind",
			workspaceDir,
			workspaceDir,
		]);
	});

	it("filters host credentials out of the sandbox environment", () => {
		const invocation = buildBwrapInvocation({
			bwrapCommand: "bwrap",
			command: ["/bin/sh", "-lc", "true"],
			cwd: workspaceDir,
			env: {
				ANTHROPIC_API_KEY: "secret",
				PATH: "/custom/bin",
				PYTHONPATH: "/workspace/pyrun",
			},
			homeDir,
			profile: "workspace-write",
		});

		expect(invocation.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(invocation.env.PATH).toBe("/custom/bin");
		expect(invocation.env.PYTHONPATH).toBe("/workspace/pyrun");
		expect(invocation.env.USER).toBe(process.env.USER);
	});

	it("mounts required runner paths outside the workspace read-only", () => {
		const runnerPath = join(tempDir, "runner", "runner-bin");
		const runnerArgPath = join(tempDir, "runner-config.json");
		const pythonPath = join(tempDir, "python-packages");
		mkdirSync(dirname(runnerPath), { recursive: true });
		mkdirSync(pythonPath, { recursive: true });
		writeFileSync(runnerPath, "runner", "utf8");
		writeFileSync(runnerArgPath, "{}", "utf8");

		const runner = createBwrapRunnerCommand({
			bwrapCommand: "/bin/true",
			cwd: workspaceDir,
			profile: "read-only",
			runnerArgs: [runnerArgPath],
			runnerCommand: runnerPath,
			runnerEnv: { PATH: "/usr/bin", PYTHONPATH: pythonPath },
		});

		for (const path of [runnerPath, runnerArgPath, pythonPath]) {
			expect(runner.args).toEqual(expect.arrayContaining(["--ro-bind", path, path]));
		}
	});

	it("resolves relative PYTHONPATH entries inside the sandbox workspace", () => {
		const hostLaunchPath = join(process.cwd(), "extensions");
		const runner = createBwrapRunnerCommand({
			bwrapCommand: "/bin/true",
			cwd: workspaceDir,
			profile: "read-only",
			runnerArgs: [],
			runnerCommand: "/usr/bin/true",
			runnerEnv: { PATH: "/usr/bin", PYTHONPATH: "extensions" },
		});

		expect(runner.args).not.toEqual(expect.arrayContaining(["--ro-bind", hostLaunchPath, hostLaunchPath]));
	});

	it.skipIf(!canExecuteBwrap)("executes runtime workers with real bwrap profile enforcement", () => {
		const runnerPath = join(workspaceDir, "runtime-probe.mjs");
		writeFileSync(
			runnerPath,
			`import { writeFileSync } from "node:fs";
import { join } from "node:path";
let workspaceWrite = true;
try {
  writeFileSync(join(process.cwd(), "probe.txt"), "ok");
} catch {
  workspaceWrite = false;
}
console.log(JSON.stringify({
  home: process.env.HOME,
  pythonPath: process.env.PYTHONPATH ?? null,
  secret: process.env.PI_TEST_SECRET ?? null,
  workspaceWrite,
}));
`,
			"utf8",
		);
		const runnerEnv = createBwrapRunnerEnvironment({
			...process.env,
			PI_TEST_SECRET: "host-secret",
			PYTHONPATH: "/home/osso",
		});
		const executeProfile = (profile: "read-only" | "workspace-write") => {
			const runner = createBwrapRunnerCommand({
				bwrapCommand: "bwrap",
				cwd: workspaceDir,
				profile,
				runnerArgs: [runnerPath],
				runnerCommand: process.execPath,
				runnerEnv,
			});
			const result = spawnSync(runner.command, runner.args, { encoding: "utf8", env: runner.env });
			expect(result.status, result.stderr).toBe(0);
			return JSON.parse(result.stdout) as {
				home: string;
				pythonPath: string | null;
				secret: string | null;
				workspaceWrite: boolean;
			};
		};

		expect(executeProfile("read-only")).toEqual({
			home: "/tmp/pi-home",
			pythonPath: null,
			secret: null,
			workspaceWrite: false,
		});
		expect(executeProfile("workspace-write")).toEqual({
			home: "/tmp/pi-home",
			pythonPath: null,
			secret: null,
			workspaceWrite: true,
		});
	});

	it("worker rejects file operations outside the workspace root", () => {
		const result = spawnSync(
			process.execPath,
			[FS_WORKER_PATH, "stat", JSON.stringify({ path: join(tempDir, "outside.txt"), workspace: workspaceDir })],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/escapes workspace/i);
	});

	it("worker rejects symlinks that resolve outside the workspace root", () => {
		const outsideFile = join(tempDir, "outside.txt");
		const workspaceLink = join(workspaceDir, "outside-link.txt");
		writeFileSync(outsideFile, "secret", "utf8");
		symlinkSync(outsideFile, workspaceLink);

		const result = spawnSync(
			process.execPath,
			[FS_WORKER_PATH, "readFile", JSON.stringify({ path: workspaceLink, workspace: workspaceDir })],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/symlink escapes workspace/i);
	});

	it("worker rejects find and grep roots outside the workspace root", () => {
		for (const operation of ["find", "grep"]) {
			const result = spawnSync(
				process.execPath,
				[
					FS_WORKER_PATH,
					operation,
					JSON.stringify({ cwd: tempDir, path: tempDir, pattern: "*", workspace: workspaceDir }),
				],
				{ encoding: "utf8" },
			);

			expect(result.status).toBe(1);
			expect(result.stderr).toMatch(/escapes workspace/i);
		}
	});

	it("grep skips inaccessible files and returns readable matches", () => {
		const readablePath = join(workspaceDir, "readable.txt");
		const inaccessiblePath = join(workspaceDir, "inaccessible.txt");
		writeFileSync(readablePath, "needle\n", "utf8");
		symlinkSync(join(workspaceDir, "missing.txt"), inaccessiblePath);

		const result = spawnSync(
			process.execPath,
			[
				FS_WORKER_PATH,
				"grep",
				JSON.stringify({
					literal: true,
					path: workspaceDir,
					pattern: "needle",
					workspace: workspaceDir,
				}),
			],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			details: {},
			text: "readable.txt:1: needle",
		});
	});

	it("bypasses sandboxing for full-access", () => {
		expect(resolveBwrapSandboxProfile("full-access")).toBeUndefined();
	});

	it("fails closed when a sandboxed profile requires bwrap and bwrap is unavailable", () => {
		expect(() => runBwrapAvailabilityCheck("/definitely/missing/bwrap")).toThrow(/bubblewrap.*required/i);
	});

	it.each(["read-only", "workspace-write"] as const)(
		"blocks tools when %s is explicitly configured and bwrap is unavailable",
		(profile) => {
			const { toolGates } = createBwrapHarness();
			const settingsManager = SettingsManager.inMemory({ sandboxProfile: profile });

			const result = toolGates[0]?.(createToolCallEvent(), createContext(settingsManager));

			expect(result).toMatchObject({ block: true, reason: expect.stringMatching(/bubblewrap.*required/i) });
		},
	);

	it("does not enforce bwrap when no sandbox profile is explicitly configured", () => {
		const { toolGates } = createBwrapHarness();
		const settingsManager = SettingsManager.inMemory();

		const result = toolGates[0]?.(createToolCallEvent(), createContext(settingsManager));

		expect(result).toBeUndefined();
	});

	it("does not enforce bwrap when full-access is explicitly configured", () => {
		const { toolGates } = createBwrapHarness();
		const settingsManager = SettingsManager.inMemory({ sandboxProfile: "full-access" });

		const result = toolGates[0]?.(createToolCallEvent(), createContext(settingsManager));

		expect(result).toBeUndefined();
	});

	it.each([
		["read-only", "pyrun_eval"],
		["workspace-write", "pyrun_eval"],
		["full-access", "pyrun_eval"],
		[undefined, "pyrun_eval"],
	] as const)("does not block %s %s", (profile, toolName) => {
		const { toolGates } = createBwrapHarness("/bin/true");
		const settingsManager = profile
			? SettingsManager.inMemory({ sandboxProfile: profile })
			: SettingsManager.inMemory();

		expect(toolGates).toHaveLength(1);
		const result = toolGates[0]?.(createToolCallEvent(toolName), createContext(settingsManager));

		expect(result).toBeUndefined();
	});
});
