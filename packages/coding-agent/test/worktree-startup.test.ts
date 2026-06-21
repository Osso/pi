import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const startupMocks = vi.hoisted(() => {
	class ExitError extends Error {
		code: number | string | null | undefined;

		constructor(code: number | string | null | undefined) {
			super(`process.exit(${code ?? 0})`);
			this.code = code;
		}
	}

	class MockWorktreeStartupError extends Error {
		constructor(message: string) {
			super(message);
			this.name = "WorktreeStartupError";
		}
	}

	return {
		ExitError,
		WorktreeStartupError: MockWorktreeStartupError,
		createAgentSessionFromServices: vi.fn(),
		createAgentSessionRuntime: vi.fn(),
		createAgentSessionServices: vi.fn(),
		events: [] as string[],
		resolveWorktree: vi.fn(),
	};
});

vi.mock("../src/utils/git-worktree.ts", () => ({
	WorktreeStartupError: startupMocks.WorktreeStartupError,
	resolveWorktree: startupMocks.resolveWorktree,
}));

vi.mock("../src/core/agent-session-runtime.ts", () => ({
	createAgentSessionRuntime: startupMocks.createAgentSessionRuntime,
}));

vi.mock("../src/core/agent-session-services.ts", () => ({
	createAgentSessionFromServices: startupMocks.createAgentSessionFromServices,
	createAgentSessionServices: startupMocks.createAgentSessionServices,
}));

import { main } from "../src/main.ts";

describe("worktree startup", () => {
	let tempDir: string;
	let agentDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;

	const fakeSettingsManager = {
		drainErrors: () => [],
		getDefaultModel: () => undefined,
		getDefaultProvider: () => undefined,
		getEnabledModels: () => undefined,
		getGlobalSettings: () => ({}),
		getHttpIdleTimeoutMs: () => undefined,
	};

	const fakeResourceLoader = {
		getExtensions: () => ({
			errors: [],
			extensions: [],
			runtime: { pendingProviderRegistrations: [] },
		}),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		tempDir = join(tmpdir(), `pi-worktree-startup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
		startupMocks.events.length = 0;

		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new startupMocks.ExitError(code);
		}) as typeof process.exit);

		startupMocks.createAgentSessionServices.mockImplementation(async (options) => {
			startupMocks.events.push(`services:${options.cwd}`);
			return {
				agentDir: options.agentDir,
				authStorage: options.authStorage,
				cwd: options.cwd,
				diagnostics: [],
				modelRegistry: {},
				resourceLoader: fakeResourceLoader,
				settingsManager: fakeSettingsManager,
			};
		});
		startupMocks.createAgentSessionFromServices.mockResolvedValue({
			modelFallbackMessage: undefined,
			session: {},
		});
		startupMocks.createAgentSessionRuntime.mockImplementation(async (factory, options) => {
			startupMocks.events.push(`runtime:${options.cwd}`);
			return factory(options);
		});
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("resolves the worktree before runtime creation and uses that cwd for session services", async () => {
		const startupCwd = join(tempDir, "project");
		const worktreeCwd = join(tempDir, "project-feature");
		startupMocks.resolveWorktree.mockImplementation(async (name, options) => {
			startupMocks.events.push(`resolve:${name}:${options.cwd}`);
			return worktreeCwd;
		});

		await expect(main(["--help", "--worktree", "feature"])).rejects.toBeInstanceOf(startupMocks.ExitError);

		expect(startupMocks.events).toEqual([
			`resolve:feature:${startupCwd}`,
			`runtime:${worktreeCwd}`,
			`services:${worktreeCwd}`,
		]);
		expect(startupMocks.createAgentSessionServices).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: worktreeCwd }),
		);
	});

	it("prints worktree startup errors and stops before runtime creation", async () => {
		startupMocks.resolveWorktree.mockRejectedValue(
			new startupMocks.WorktreeStartupError("fatal: not a git repository"),
		);

		await expect(main(["--help", "-w", "feature"])).rejects.toMatchObject({ code: 1 });

		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Error: fatal: not a git repository"));
		expect(startupMocks.createAgentSessionRuntime).not.toHaveBeenCalled();
		expect(startupMocks.createAgentSessionServices).not.toHaveBeenCalled();
	});
});
