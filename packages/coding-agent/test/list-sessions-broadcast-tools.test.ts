import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	archiveSession,
	claimNextSupervisorRequest,
	completeSupervisorRequest,
	getControlDbPath,
	listPendingArchitectRequests,
	writeSessionHealth,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";
import { emptySessionHealth } from "../src/core/session-health.ts";
import { SUPERVISOR_ONLY_TOOL_NAMES } from "../src/core/tool-capabilities.ts";
import { createAskArchitectToolDefinition } from "../src/core/tools/ask-architect.ts";
import { createAskSupervisorToolDefinition } from "../src/core/tools/ask-supervisor.ts";
import { createChannelPostToolDefinition } from "../src/core/tools/channel-post.ts";
import { createAllToolDefinitions, DEFAULT_ACTIVE_TOOL_NAMES } from "../src/core/tools/index.ts";
import { createListSessionsToolDefinition } from "../src/core/tools/list-sessions.ts";

describe("session coordination tools", () => {
	it("registers active session coordination tools while Architect requests are disabled", () => {
		const tools = createAllToolDefinitions("/tmp");
		expect(DEFAULT_ACTIVE_TOOL_NAMES).not.toContain("ask_architect");
		expect(tools).not.toHaveProperty("ask_architect");
		expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("ask_supervisor");
		expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("list_sessions");
		expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("broadcast");
		expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("channel_post");
		expect(tools.ask_supervisor.name).toBe("ask_supervisor");
		expect(tools.list_sessions.name).toBe("list_sessions");
		expect(tools.broadcast.name).toBe("broadcast");
		expect(tools.channel_post.name).toBe("channel_post");
		expect(tools.list_sessions.description).toContain("sticky liveness");
		expect(tools.broadcast.description).toContain("eligible");
		expect(tools.channel_post.description).toContain("shared channel");
	});

	it("persists Architect requests from a main runtime with historical subagent provenance", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-ask-architect-tool-"));
		try {
			const controlDbPath = getControlDbPath(agentDir);
			const tool = createAskArchitectToolDefinition();
			const projectPath = mkdtempSync(join(agentDir, "project-worktree-"));
			const projectLink = join(agentDir, "active-worktree");
			symlinkSync(projectPath, projectLink);
			const result = await tool.execute(
				"ask-architect",
				{ message: "inspect this", project_path: projectLink },
				undefined,
				undefined,
				{
					controlDbPath,
					cwd: "/repos/canonical",
					sessionManager: {
						getSessionId: () => "main-session",
						isSubagentSession: () => true,
					},
				} as Parameters<typeof tool.execute>[4],
			);

			expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Architect request queued") }]);
			expect(result.details?.senderSessionId).toBe("main-session");
			expect(listPendingArchitectRequests(controlDbPath)).toEqual([
				expect.objectContaining({ projectCwd: projectPath }),
			]);
		} finally {
			rmSync(agentDir, { force: true, recursive: true });
		}
	});

	it("defaults Architect project context to the session cwd", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-ask-architect-default-"));
		try {
			const controlDbPath = getControlDbPath(agentDir);
			const tool = createAskArchitectToolDefinition();
			await tool.execute("ask-architect", { message: "inspect this" }, undefined, undefined, {
				controlDbPath,
				cwd: "/repos/canonical",
				sessionManager: { getSessionId: () => "main-session" },
			} as Parameters<typeof tool.execute>[4]);

			expect(listPendingArchitectRequests(controlDbPath)).toEqual([
				expect.objectContaining({ projectCwd: "/repos/canonical" }),
			]);
		} finally {
			rmSync(agentDir, { force: true, recursive: true });
		}
	});

	it("rejects invalid explicit Architect project paths", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-ask-architect-invalid-"));
		try {
			const filePath = join(agentDir, "file.txt");
			writeFileSync(filePath, "not a directory");
			const tool = createAskArchitectToolDefinition();
			const context = {
				controlDbPath: "/unused",
				cwd: "/repos/canonical",
				sessionManager: { getSessionId: () => "main-session" },
			} as Parameters<typeof tool.execute>[4];

			for (const projectPath of ["", "../worktree"]) {
				await expect(
					tool.execute(
						"ask-architect",
						{ message: "inspect this", project_path: projectPath },
						undefined,
						undefined,
						context,
					),
				).rejects.toThrow("project_path must be a non-empty absolute path");
			}
			await expect(
				tool.execute(
					"ask-architect",
					{ message: "inspect this", project_path: join(agentDir, "missing") },
					undefined,
					undefined,
					context,
				),
			).rejects.toThrow("project_path must reference an existing directory");
			await expect(
				tool.execute(
					"ask-architect",
					{ message: "inspect this", project_path: filePath },
					undefined,
					undefined,
					context,
				),
			).rejects.toThrow("project_path must reference a directory");
		} finally {
			rmSync(agentDir, { force: true, recursive: true });
		}
	});

	it("rejects Architect requests from subagent runtimes", async () => {
		const tool = createAskArchitectToolDefinition();

		for (const context of [
			{
				controlDbPath: "/unused",
				multiAgentAgentId: "agent_1",
				sessionManager: { getSessionId: () => "child-session" },
			},
			{
				controlDbPath: "/unused",
				multiAgentRequiresAgentId: true,
				sessionManager: { getSessionId: () => "child-session" },
			},
		]) {
			await expect(
				tool.execute(
					"ask-architect",
					{ message: "inspect this" },
					undefined,
					undefined,
					context as Parameters<typeof tool.execute>[4],
				),
			).rejects.toThrow("ask_architect is only available from main sessions");
		}
	});

	it("filters Supervisor advisory capability from subagent runtimes", () => {
		expect(SUPERVISOR_ONLY_TOOL_NAMES).toContain("ask_supervisor");
	});

	it("bounds Supervisor advisory input and rejects subagent runtimes", async () => {
		const tool = createAskSupervisorToolDefinition();
		expect((tool.parameters.properties.question as { maxLength?: number }).maxLength).toBe(4_000);
		expect((tool.parameters.properties.context as { maxLength?: number }).maxLength).toBe(8_000);

		for (const context of [
			{
				controlDbPath: "/unused",
				multiAgentAgentId: "agent_1",
				sessionManager: { getSessionId: () => "child-session" },
			},
			{
				controlDbPath: "/unused",
				multiAgentRequiresAgentId: true,
				sessionManager: { getSessionId: () => "child-session" },
			},
		]) {
			await expect(
				tool.execute(
					"ask-supervisor",
					{ question: "Is this complete?" },
					undefined,
					undefined,
					context as Parameters<typeof tool.execute>[4],
				),
			).rejects.toThrow("ask_supervisor is only available from main sessions");
		}
	});
});

describe("historical subagent session authorization", () => {
	it("reaches Supervisor request persistence from a main runtime with historical subagent provenance", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-ask-supervisor-tool-"));
		try {
			const controlDbPath = getControlDbPath(agentDir);
			const tool = createAskSupervisorToolDefinition();
			const decision = tool.execute("ask-supervisor", { question: "Is this complete?" }, undefined, undefined, {
				controlDbPath,
				cwd: "/repos/canonical",
				sessionManager: {
					getSessionId: () => "main-session",
					isSubagentSession: () => true,
				},
			} as Parameters<typeof tool.execute>[4]);
			const request = claimNextSupervisorRequest(controlDbPath, "test-runtime");
			if (!request) throw new Error("expected persisted Supervisor advisory request");
			expect(request).toMatchObject({
				kind: "supervisor_advisory",
				payload: { question: "Is this complete?" },
				senderSessionId: "main-session",
			});
			if (!request.claimToken) throw new Error("expected Supervisor request claim token");
			completeSupervisorRequest(controlDbPath, request.id, request.claimToken, {
				kind: "advisory",
				answer: "Continue.",
			});

			await expect(decision).resolves.toMatchObject({
				content: [{ type: "text", text: "Continue." }],
				details: { senderSessionId: "main-session" },
			});
		} finally {
			rmSync(agentDir, { force: true, recursive: true });
		}
	});
});

describe("session inventory and channel tools", () => {
	it("never returns archived rows when list_sessions receives include_ended true", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-list-sessions-archived-tool-"));
		try {
			const controlDbPath = getControlDbPath(agentDir);
			for (const session of [
				{
					sessionPath: "/sessions/active.jsonl",
					id: "active",
					cwd: "/repo/active",
				},
				{
					sessionPath: "/sessions/archived.jsonl",
					id: "archived",
					cwd: "/repo/archived",
				},
			]) {
				writeSessionMetadata(controlDbPath, {
					...session,
					createdAt: "2026-01-01T00:00:00.000Z",
					modifiedAt: "2026-01-01T00:10:00.000Z",
					messageCount: 1,
					firstMessage: "hello",
					allMessagesText: "hello",
				});
			}
			archiveSession(controlDbPath, "/sessions/archived.jsonl");
			const tool = createListSessionsToolDefinition();

			const result = await tool.execute("list-sessions", { include_ended: true }, undefined, undefined, {
				controlDbPath,
				sessionManager: {
					getSessionFile: () => "/sessions/current.jsonl",
					getSessionId: () => "current",
				},
			} as Parameters<typeof tool.execute>[4]);

			expect(result.details?.sessions.map((session) => session.sessionId)).toEqual(["active"]);
			expect(result.content[0]).toEqual({ type: "text", text: expect.not.stringContaining("archived") });
		} finally {
			rmSync(agentDir, { force: true, recursive: true });
		}
	});

	it("excludes ended rows when list_sessions receives include_ended false", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-list-sessions-tool-"));
		try {
			const controlDbPath = getControlDbPath(agentDir);
			writeSessionMetadata(controlDbPath, {
				sessionPath: "/sessions/ended.jsonl",
				id: "ended",
				cwd: "/repo/ended",
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-01T00:10:00.000Z",
				messageCount: 1,
				firstMessage: "hello",
				allMessagesText: "hello",
			});
			writeSessionHealth(controlDbPath, {
				...emptySessionHealth("ended"),
				agentGeneration: 1,
				checkStatus: "dead",
				checkedGeneration: 1,
			});
			const tool = createListSessionsToolDefinition();

			const result = await tool.execute("list-sessions", { include_ended: false }, undefined, undefined, {
				controlDbPath,
				sessionManager: {
					getSessionFile: () => "/sessions/current-without-metadata.jsonl",
					getSessionId: () => "current-without-metadata",
				},
			} as Parameters<typeof tool.execute>[4]);

			expect(result.details?.sessions).toEqual([]);
			expect(result.content).toEqual([{ type: "text", text: "No sessions found." }]);
		} finally {
			rmSync(agentDir, { force: true, recursive: true });
		}
	});

	it("rejects channel_post from subagent contexts by default", async () => {
		const tool = createChannelPostToolDefinition();

		await expect(
			tool.execute("channel-post", { message: "hello" }, undefined, undefined, {
				multiAgentAgentId: "agent_1",
			} as Parameters<typeof tool.execute>[4]),
		).rejects.toThrow("channel_post is only available from main sessions");
	});
});
