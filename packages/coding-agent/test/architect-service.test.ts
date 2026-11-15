import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import {
	ARCHITECT_EXCLUDED_TOOL_NAMES,
	ArchitectConsolePromptQueue,
	blockArchitectRestrictedTool,
	completeSentArchitectRequest,
	createArchitectConsoleSnapshot,
	createArchitectMultiAgentStore,
	createArchitectSettingsManager,
	createArchitectStopHandler,
	openArchitectSession,
	runArchitectCycle,
	runArchitectServiceLoop,
	waitForArchitectInterval,
} from "../src/architect/main.ts";
import { readProjectSpec } from "../src/architect/project-spec.ts";
import { ARCHITECT_SYSTEM_PROMPT, buildArchitectPrompt } from "../src/architect/prompt.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import {
	getControlDbPath,
	readSessionMetadata,
	registerRuntimeMailboxListener,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SUPERVISOR_ONLY_TOOL_NAMES } from "../src/core/tool-capabilities.ts";

describe("resident architect service", () => {
	it("retains the newest Architect transcript and removes stale files and metadata", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-architect-sessions-"));
		const controlDbPath = getControlDbPath(agentDir);
		const sessionDir = join(agentDir, "architect-sessions");
		mkdirSync(sessionDir);
		const legacyPath = join(sessionDir, "architect.jsonl");
		const stalePath = join(sessionDir, "2026-09-01T00-00-00-000Z_architect.jsonl");
		const retainedPath = join(sessionDir, "2026-09-02T00-00-00-000Z_architect.jsonl");
		try {
			for (const [sessionPath, name] of [
				[legacyPath, "Remove legacy"],
				[stalePath, "Remove me"],
				[retainedPath, "Retain me"],
			] as const) {
				writeFileSync(
					sessionPath,
					`${JSON.stringify({
						type: "session",
						version: 3,
						id: "architect",
						timestamp: "2026-09-01T00:00:00.000Z",
						cwd: agentDir,
					})}\n`,
				);
				writeSessionMetadata(controlDbPath, {
					sessionPath,
					id: "architect",
					cwd: agentDir,
					name,
					createdAt: "2026-09-01T00:00:00.000Z",
					modifiedAt: "2026-09-01T00:00:00.000Z",
					messageCount: 0,
					firstMessage: "(no messages)",
				});
			}

			const session = openArchitectSession(agentDir, agentDir, controlDbPath);

			expect(session.getSessionFile()).toBe(retainedPath);
			expect(existsSync(legacyPath)).toBe(false);
			expect(readSessionMetadata(controlDbPath, legacyPath)).toBeUndefined();
			expect(existsSync(stalePath)).toBe(false);
			expect(readSessionMetadata(controlDbPath, stalePath)).toBeUndefined();
			expect(existsSync(retainedPath)).toBe(true);
			expect(readSessionMetadata(controlDbPath, retainedPath)).toMatchObject({ name: "Retain me" });
		} finally {
			rmSync(agentDir, { force: true, recursive: true });
		}
	});

	it("retains a live Architect transcript while pruning stale files and fileless metadata", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-architect-live-session-"));
		const controlDbPath = getControlDbPath(agentDir);
		const sessionDir = join(agentDir, "architect-sessions");
		mkdirSync(sessionDir);
		const activePath = join(sessionDir, "2026-09-01T00-00-00-000Z_architect.jsonl");
		const stalePath = join(sessionDir, "2026-09-02T00-00-00-000Z_architect.jsonl");
		const missingPath = join(sessionDir, "2026-09-03T00-00-00-000Z_architect.jsonl");
		try {
			for (const sessionPath of [activePath, stalePath]) {
				writeFileSync(
					sessionPath,
					`${JSON.stringify({
						type: "session",
						version: 3,
						id: "architect",
						timestamp: "2026-09-01T00:00:00.000Z",
						cwd: agentDir,
					})}\n`,
				);
			}
			for (const [sessionPath, name] of [
				[activePath, "Live transcript"],
				[stalePath, "Stale transcript"],
				[missingPath, "Missing transcript"],
			] as const) {
				writeSessionMetadata(controlDbPath, {
					sessionPath,
					id: "architect",
					cwd: agentDir,
					name,
					createdAt: "2026-09-01T00:00:00.000Z",
					modifiedAt: "2026-09-01T00:00:00.000Z",
					messageCount: 1,
					firstMessage: name,
				});
			}
			registerRuntimeMailboxListener(
				controlDbPath,
				{ agentId: null, sessionId: "architect" },
				process.pid,
				activePath,
			);

			const session = openArchitectSession(agentDir, agentDir, controlDbPath);

			expect(session.getSessionFile()).toBe(activePath);
			expect(existsSync(activePath)).toBe(true);
			expect(readSessionMetadata(controlDbPath, activePath)).toMatchObject({ name: "Live transcript" });
			expect(existsSync(stalePath)).toBe(false);
			expect(readSessionMetadata(controlDbPath, stalePath)).toBeUndefined();
			expect(readSessionMetadata(controlDbPath, missingPath)).toBeUndefined();
		} finally {
			rmSync(agentDir, { force: true, recursive: true });
		}
	});

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

	it("keeps Architect findings advisory instead of issuing supervisor directives", () => {
		expect(ARCHITECT_SYSTEM_PROMPT).toContain("Findings are advisory hypotheses");
		expect(ARCHITECT_SYSTEM_PROMPT).toContain("Do not issue commands, execution gates, stop conditions");
		expect(ARCHITECT_SYSTEM_PROMPT).toContain("Do not reinterpret or add goal completion criteria");
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
				expect(session.systemPrompt).toContain("<user_rules>\nOBSERVER_SHARED_RULE\n</user_rules>");
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
		expect(ARCHITECT_EXCLUDED_TOOL_NAMES).toEqual(["ask_architect", "contact_parent", ...SUPERVISOR_ONLY_TOOL_NAMES]);
	});

	it("persists direct-message state to the shared control DB", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-architect-store-"));
		try {
			const sessionManager = SessionManager.create("/home/osso", agentDir, { id: "architect" });
			const controlDbPath = getControlDbPath(agentDir);
			const store = createArchitectMultiAgentStore(sessionManager, controlDbPath);
			const sessionPath = sessionManager.getSessionFile();
			if (!sessionPath) throw new Error("Architect session should be persisted");

			expect(store.getPersistenceTarget()).toEqual({
				controlDbPath,
				sessionPath,
			});
			expect(readSessionMetadata(getControlDbPath(agentDir), sessionPath)).toMatchObject({
				isArchived: true,
				archivedAt: expect.any(String),
			});
			expect(existsSync(`${sessionPath}.zst`)).toBe(false);
		} finally {
			rmSync(agentDir, { force: true, recursive: true });
		}
	});

	it("blocks shared channel and global session inventory", () => {
		expect(blockArchitectRestrictedTool({ input: {}, toolName: "channel_post" })).toMatchObject({ block: true });
		expect(blockArchitectRestrictedTool({ input: {}, toolName: "list_sessions" })).toMatchObject({ block: true });
		expect(blockArchitectRestrictedTool({ input: {}, toolName: "broadcast" })).toBeUndefined();
		expect(ARCHITECT_SYSTEM_PROMPT).not.toContain("broadcast");
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

	it("wakes the Architect observation wait when a console prompt arrives", async () => {
		const queue = new ArchitectConsolePromptQueue();
		const controller = new AbortController();
		const wait = queue.wait(controller.signal);
		queue.enqueue("inspect this", "prompt-1");
		await expect(wait).resolves.toBeUndefined();
		expect(queue.take()).toEqual({ id: "prompt-1", text: "inspect this" });
	});

	it("serializes console prompts with normal Architect observation turns", async () => {
		const queue = new ArchitectConsolePromptQueue();
		const controller = new AbortController();
		const turns: string[] = [];
		let activePrompts = 0;
		let maximumActivePrompts = 0;
		let observationCount = 0;
		queue.enqueue("console turn", "prompt-1");
		await runArchitectServiceLoop({
			observer: {
				observe: () => {
					observationCount += 1;
					return observationCount === 1
						? { reason: "session_state_changed", requests: [], sessions: [] }
						: undefined;
				},
			},
			promptQueue: queue,
			signal: controller.signal,
			prompt: async (content) => {
				activePrompts += 1;
				maximumActivePrompts = Math.max(maximumActivePrompts, activePrompts);
				turns.push(content.includes("session_state_changed") ? "observation" : content);
				await Promise.resolve();
				activePrompts -= 1;
				if (turns.length === 2) controller.abort();
			},
		});
		expect(turns).toEqual(["observation", "console turn"]);
		expect(maximumActivePrompts).toBe(1);
	});

	it("exposes exact Architect branch identity through the console snapshot", () => {
		const branch = [
			{
				type: "custom" as const,
				id: "entry-1",
				parentId: null,
				timestamp: "2026-07-28T00:00:00.000Z",
				customType: "test",
			},
		];
		const snapshot = createArchitectConsoleSnapshot({
			cwd: "/fixed/architect",
			generation: 17,
			session: { sessionId: "architect", sessionManager: { getBranch: () => branch } },
		});
		expect(snapshot).toEqual({
			service: "architect",
			sessionId: "architect",
			cwd: "/fixed/architect",
			generation: 17,
			branch,
		});
	});

	it("starts and closes the Architect console with the resident lifecycle", async () => {
		const start = vi.fn(async () => undefined);
		const close = vi.fn(async () => undefined);
		const controller = new AbortController();
		controller.abort();
		await runArchitectServiceLoop({
			consoleServer: { start, close },
			observer: { observe: () => undefined },
			prompt: async () => undefined,
			promptQueue: new ArchitectConsolePromptQueue(),
			signal: controller.signal,
		});
		expect(start).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
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
});
