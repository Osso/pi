import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import {
	ARCHITECT_EXCLUDED_TOOL_NAMES,
	ARCHITECT_RULES_SCOPE,
	blockArchitectGlobalBroadcast,
	completeSentArchitectRequest,
	createArchitectMultiAgentStore,
	createArchitectSettingsManager,
	createArchitectStopHandler,
	runArchitectCycle,
	waitForArchitectInterval,
} from "../src/architect/main.ts";
import { readProjectSpec } from "../src/architect/project-spec.ts";
import { ARCHITECT_SYSTEM_PROMPT, buildArchitectPrompt } from "../src/architect/prompt.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { getControlDbPath, readSessionMetadata } from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SUPERVISOR_ONLY_TOOL_NAMES } from "../src/core/tool-capabilities.ts";

const deployScript = fileURLToPath(new URL("../../../deploy.sh", import.meta.url));
const serviceUnit = fileURLToPath(new URL("../systemd/pi-architect.service", import.meta.url));
const systemdPathValidator = fileURLToPath(new URL("../../../scripts/validate-systemd-exec-path.mjs", import.meta.url));

describe("resident architect service", () => {
	it("uses the structured observer snapshot instead of list_sessions", () => {
		const prompt = buildArchitectPrompt({ reason: "session_state_changed", requests: [], sessions: [] });

		expect(prompt).not.toContain("list_sessions");
		expect(ARCHITECT_SYSTEM_PROMPT).toContain("Do not call list_sessions");
	});

	it("directs explicit project requests to authoritative specs", () => {
		const prompt = buildArchitectPrompt({
			reason: "architect_request",
			requests: [
				{
					id: 7,
					senderSessionId: "main-session",
					projectCwd: "/repos/project",
					body: "review this design",
					status: "claimed",
					createdAt: "2026-07-17T00:00:00.000Z",
				},
			],
			sessions: [],
		});

		expect(prompt).toContain("/repos/project");
		expect(ARCHITECT_SYSTEM_PROMPT).toContain("docs/specs/README.md");
		expect(ARCHITECT_SYSTEM_PROMPT).toContain("relevant feature spec");
		expect(ARCHITECT_SYSTEM_PROMPT).toContain("Do not ask the sender to copy the spec");
	});

	it("reads specs from the project root above a nested sender cwd", async () => {
		const projectDir = mkdtempSync(join(tmpdir(), "pi-architect-project-"));
		try {
			const specDir = join(projectDir, "docs", "specs");
			const nestedCwd = join(projectDir, "packages", "feature");
			mkdirSync(specDir, { recursive: true });
			mkdirSync(nestedCwd, { recursive: true });
			writeFileSync(join(specDir, "README.md"), "spec index");
			writeFileSync(join(specDir, "feature.md"), "feature contract");

			await expect(readProjectSpec(nestedCwd, "feature.md")).resolves.toBe("feature contract");
			await expect(readProjectSpec(nestedCwd, "../secret.md")).rejects.toThrow("inside docs/specs");
		} finally {
			rmSync(projectDir, { force: true, recursive: true });
		}
	});

	it("rejects spec symlinks that escape docs/specs", async () => {
		const projectDir = mkdtempSync(join(tmpdir(), "pi-architect-project-"));
		try {
			const specDir = join(projectDir, "docs", "specs");
			mkdirSync(specDir, { recursive: true });
			writeFileSync(join(specDir, "README.md"), "spec index");
			writeFileSync(join(projectDir, "secret.md"), "secret");
			symlinkSync(join(projectDir, "secret.md"), join(specDir, "escape.md"));

			await expect(readProjectSpec(projectDir, "escape.md")).rejects.toThrow("inside docs/specs");
		} finally {
			rmSync(projectDir, { force: true, recursive: true });
		}
	});

	it("marks legacy requests as missing project context", () => {
		const prompt = buildArchitectPrompt({
			reason: "architect_request",
			requests: [
				{
					id: 8,
					senderSessionId: "legacy-session",
					body: "review this design",
					status: "claimed",
					createdAt: "2026-07-17T00:00:00.000Z",
				},
			],
			sessions: [],
		});

		expect(prompt).not.toContain("projectCwd");
		expect(ARCHITECT_SYSTEM_PROMPT).toContain("state that project context is unavailable instead of guessing");
	});

	it("anchors liveness to prefiltered snapshot membership instead of goal fields", () => {
		expect(ARCHITECT_SYSTEM_PROMPT).toContain(
			"Goal completion does not end a live session or require it to disappear from observations.",
		);
		expect(ARCHITECT_SYSTEM_PROMPT).toContain("Treat completedAt only as goal state.");
		expect(ARCHITECT_SYSTEM_PROMPT).toContain(
			"The bounded sessions list already represents main-listener and fresh-health filtering.",
		);
		expect(ARCHITECT_SYSTEM_PROMPT).toContain("Use session membership, never goal fields, as liveness evidence.");
	});

	it("loads main-thread rules into the resident Architect prompt", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-architect-rules-"));
		const sentinel = "ARCHITECT_MAIN_RULE_SENTINEL";
		try {
			const rulesDir = join(agentDir, "rules", "main");
			mkdirSync(rulesDir, { recursive: true });
			writeFileSync(join(rulesDir, "sentinel.md"), sentinel);
			const model = getModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected test model");

			const { session } = await createAgentSession({
				agentDir,
				cwd: agentDir,
				model,
				multiAgentRuntimeRole: "observer",
				rulesScope: ARCHITECT_RULES_SCOPE,
				sessionManager: SessionManager.inMemory(agentDir),
				settingsManager: createArchitectSettingsManager(),
			});
			try {
				expect(session.systemPrompt).toContain(`<user_rules>${sentinel}</user_rules>`);
			} finally {
				session.dispose();
			}
		} finally {
			rmSync(agentDir, { force: true, recursive: true });
		}
	});

	it("keeps ordinary observer sessions shared-only", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-observer-rules-"));
		try {
			const rulesDir = join(agentDir, "rules");
			mkdirSync(join(rulesDir, "main"), { recursive: true });
			writeFileSync(join(rulesDir, "shared.md"), "OBSERVER_SHARED_RULE");
			writeFileSync(join(rulesDir, "main", "sentinel.md"), "OBSERVER_MAIN_RULE");
			const model = getModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected test model");

			const { session } = await createAgentSession({
				agentDir,
				cwd: agentDir,
				model,
				multiAgentRuntimeRole: "observer",
				sessionManager: SessionManager.inMemory(agentDir),
				settingsManager: createArchitectSettingsManager(),
			});
			try {
				expect(session.systemPrompt).toContain("<user_rules>OBSERVER_SHARED_RULE</user_rules>");
				expect(session.systemPrompt).not.toContain("OBSERVER_MAIN_RULE");
			} finally {
				session.dispose();
			}
		} finally {
			rmSync(agentDir, { force: true, recursive: true });
		}
	});

	it("uses the read-only Bubblewrap profile", () => {
		expect(createArchitectSettingsManager().getExplicitSandboxProfile()).toBe("read-only");
	});

	it("keeps supervisor-only tools out of the architect runtime", () => {
		expect(ARCHITECT_EXCLUDED_TOOL_NAMES).toEqual([
			"ask_architect",
			"broadcast",
			"contact_parent",
			...SUPERVISOR_ONLY_TOOL_NAMES,
		]);
	});

	it("persists direct-message state to the shared control DB", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-architect-store-"));
		try {
			const sessionManager = SessionManager.create("/home/osso", agentDir, { id: "architect" });
			const store = createArchitectMultiAgentStore(sessionManager, agentDir);
			const sessionPath = sessionManager.getSessionFile();
			if (!sessionPath) throw new Error("Architect session should be persisted");

			expect(store.getPersistenceTarget()).toEqual({
				controlDbPath: join(agentDir, "control.sqlite"),
				sessionPath,
			});
			expect(readSessionMetadata(getControlDbPath(agentDir), sessionPath)).toMatchObject({
				isArchived: true,
				archivedAt: expect.any(String),
			});
		} finally {
			rmSync(agentDir, { force: true, recursive: true });
		}
	});

	it("blocks global fanout and broadcast delivery", () => {
		expect(blockArchitectGlobalBroadcast({ input: {}, toolName: "channel_post" })).toMatchObject({ block: true });
		expect(blockArchitectGlobalBroadcast({ input: {}, toolName: "broadcast" })).toMatchObject({ block: true });
		expect(
			blockArchitectGlobalBroadcast({ input: { session_ids: ["affected-session"] }, toolName: "broadcast" }),
		).toMatchObject({ block: true });
		expect(blockArchitectGlobalBroadcast({ input: {}, toolName: "list_sessions" })).toMatchObject({ block: true });
	});

	it("forces service shutdown after a bounded graceful abort", async () => {
		vi.useFakeTimers();
		try {
			const controller = new AbortController();
			const abortSession = vi.fn(() => new Promise<void>(() => {}));
			const exit = vi.fn();
			const stop = createArchitectStopHandler({ abortController: controller, abortSession, exit });

			stop();
			await vi.advanceTimersByTimeAsync(5_000);

			expect(controller.signal.aborted).toBe(true);
			expect(abortSession).toHaveBeenCalledOnce();
			expect(exit).toHaveBeenCalledWith(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops the observation wait immediately when the service is signaled", async () => {
		const controller = new AbortController();
		const wait = waitForArchitectInterval(controller.signal);
		controller.abort();

		await expect(wait).resolves.toBeUndefined();
	});

	it("does not prompt Sol when the observer has no material change", async () => {
		let promptCount = 0;

		await runArchitectCycle({ observe: () => undefined }, async () => {
			promptCount += 1;
		});

		expect(promptCount).toBe(0);
	});

	it("prompts Sol with the material observation", async () => {
		const observation = {
			reason: "session_state_changed" as const,
			requests: [],
			sessions: [],
		};
		let received: unknown;

		await runArchitectCycle({ observe: () => observation }, async (prompt) => {
			received = prompt;
		});

		expect(received).toContain("session_state_changed");
	});

	it("completes a durable Architect request only after successful direct transport", () => {
		const completeRequest = vi.fn();

		completeSentArchitectRequest(
			{ completeRequest },
			{ threadId: "architect-request:7", toAgentId: "main", toSessionId: "main-session" },
		);
		completeSentArchitectRequest(
			{ completeRequest },
			{ threadId: "unrelated", toAgentId: "main", toSessionId: "main-session" },
		);
		completeSentArchitectRequest(
			{ completeRequest },
			{ threadId: "architect-request:8", toAgentId: "agent_1", toSessionId: "main-session" },
		);

		expect(completeRequest).toHaveBeenCalledOnce();
		expect(completeRequest).toHaveBeenCalledWith(7, "main-session");
	});

	it("renews request claims while a model turn remains active", async () => {
		vi.useFakeTimers();
		try {
			const observation = {
				reason: "architect_request" as const,
				requests: [
					{
						id: 7,
						senderSessionId: "main-session",
						body: "inspect this",
						status: "claimed" as const,
						createdAt: "2026-07-10T00:00:00.000Z",
					},
				],
				sessions: [],
			};
			const renewRequests = vi.fn();
			let releasePrompt: (() => void) | undefined;
			const prompt = new Promise<void>((resolve) => {
				releasePrompt = resolve;
			});
			const cycle = runArchitectCycle({ observe: () => observation, renewRequests }, () => prompt);

			await vi.advanceTimersByTimeAsync(30_000);
			expect(renewRequests).toHaveBeenCalledWith([7]);
			releasePrompt?.();
			await cycle;
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects paths that cannot be inserted safely into systemd ExecStart", () => {
		const safe = spawnSync(process.execPath, [systemdPathValidator, "/home/osso/.local/bin/pi"], {
			encoding: "utf8",
		});
		const whitespace = spawnSync(process.execPath, [systemdPathValidator, "/tmp/pi bin/pi"], { encoding: "utf8" });
		const specifier = spawnSync(process.execPath, [systemdPathValidator, "/tmp/pi%h/pi"], { encoding: "utf8" });
		const singleQuote = spawnSync(process.execPath, [systemdPathValidator, "/tmp/pi'bin/pi"], { encoding: "utf8" });
		const environment = spawnSync(process.execPath, [systemdPathValidator, "/tmp/pi$HOME/pi"], { encoding: "utf8" });
		const replacement = spawnSync(process.execPath, [systemdPathValidator, "/tmp/pi&bin/pi"], { encoding: "utf8" });

		expect(safe.status).toBe(0);
		expect(whitespace.status).toBe(1);
		expect(whitespace.stderr).toContain("systemd ExecStart");
		expect(specifier.status).toBe(1);
		expect(specifier.stderr).toContain("systemd ExecStart");
		expect(singleQuote.status).toBe(1);
		expect(singleQuote.stderr).toContain("systemd ExecStart");
		expect(environment.status).toBe(1);
		expect(environment.stderr).toContain("systemd ExecStart");
		expect(replacement.status).toBe(1);
		expect(replacement.stderr).toContain("systemd ExecStart");
	});

	it("renders the configured binary path and verifies the restarted Architect service", () => {
		const deploy = readFileSync(deployScript, "utf8");
		const unit = readFileSync(serviceUnit, "utf8");

		expect(unit).toContain("ExecStart=@PI_ARCHITECT_BINARY@ architect");
		expect(deploy).toContain("@PI_ARCHITECT_BINARY@");
		expect(deploy).not.toContain("@PI_NODE_LAUNCHER@");
		expect(deploy).not.toContain("@PI_TSCONFIG@");
		expect(deploy).not.toContain("@PI_CLI_SOURCE@");
		expect(deploy).toContain("pi-architect.service");
		expect(deploy).toContain('XDG_RUNTIME_DIR="');
		expect(deploy).toContain("/run/user/$(id -u)");
		expect(deploy).toContain('DBUS_SESSION_BUS_ADDRESS="');
		expect(deploy).toContain("unix:path=$XDG_RUNTIME_DIR/bus");
		expect(deploy).toContain("systemctl --user daemon-reload");
		expect(deploy).toContain("systemctl --user enable --now pi-architect.service");
		expect(deploy).toContain("systemctl --user restart pi-architect.service");
		expect(deploy).toContain("systemctl --user is-active --quiet pi-architect.service");
		expect(deploy).not.toContain('"$USER"');
	});
});
