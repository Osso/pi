import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { createAskSupervisorToolDefinition } from "../src/core/tools/ask-supervisor.ts";
import { reviewGoalWithResidentSupervisor } from "../extensions/goal/src/supervisor-review.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("standalone worker SDK", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-standalone-sdk-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	it("defaults to in-memory and blocks reactivating Supervisor tools", async () => {
		const { session } = await createAgentSession({
			noSupervisor: true,
			cwd,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5"),
		});
		try {
			expect(session.sessionManager.isPersisted()).toBe(false);
			session.setActiveToolsByName(["read", "ask_supervisor", "channel_post"]);
			expect(session.getActiveToolNames()).toContain("read");
			expect(session.getActiveToolNames()).not.toContain("ask_supervisor");
			expect(session.getActiveToolNames()).not.toContain("channel_post");
			const ctx = session.extensionRunner.createContext();
			await expect(
				createAskSupervisorToolDefinition().execute(
					"hidden-advisory",
					{ question: "must not look up a resident" },
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow("unavailable in standalone worker mode");
			await expect(reviewGoalWithResidentSupervisor({ ctx, kind: "goal_idle_review", payload: {} })).rejects.toThrow(
				"unavailable in standalone worker mode",
			);
		} finally {
			session.dispose();
		}
	});
	it("rejects persisted session managers before creating runtime services", async () => {
		await expect(
			createAgentSession({
				noSupervisor: true,
				cwd,
				agentDir,
				model: getModel("anthropic", "claude-sonnet-4-5"),
				sessionManager: SessionManager.create(cwd, join(root, "sessions")),
			}),
		).rejects.toThrow("requires an in-memory session");
	});
	it("rejects orchestration identity", async () => {
		await expect(
			createAgentSession({
				noSupervisor: true,
				cwd,
				agentDir,
				model: getModel("anthropic", "claude-sonnet-4-5"),
				multiAgentRuntimeRole: "child",
			}),
		).rejects.toThrow("cannot receive multi-agent orchestration");
	});
	it("rejects Supervisor-dependent approval without changing the configured policy", async () => {
		const { session } = await createAgentSession({
			noSupervisor: true,
			cwd,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5"),
			supervisorDecisionRequester: async () => {
				throw new Error("Unexpected Supervisor contact");
			},
		});
		try {
			session.settingsManager.setApprovalPreset("llm-approved-deny");
			const write = session.agent.state.tools.find((tool) => tool.name === "write")!;
			const toolCall = {
				id: "blocked-write",
				type: "toolCall" as const,
				name: "write",
				arguments: { path: "blocked.txt", content: "no" },
			};
			const response = await session.agent.beforeToolCall!({
				toolCall,
				args: toolCall.arguments,
				context: { messages: [], systemPrompt: "", tools: [write] },
				assistantMessage: {
					role: "assistant",
					content: [toolCall],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "toolUse",
					timestamp: Date.now(),
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			});
			expect(response).toEqual({
				block: true,
				reason: "Supervisor approval is unavailable in standalone worker mode",
			});
			expect(session.settingsManager.getApprovalPreset()).toBe("llm-approved-deny");
		} finally {
			session.dispose();
		}
	});
});
