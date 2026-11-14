import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import bridge, { __test } from "../extensions/claude-bridge/src/index.ts";
import { userMessage } from "../extensions/claude-bridge/src/prompt-stream.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let root: string | undefined;
afterEach(() => {
	__test.setQuery(null);
	__test.resetSharedSession();
	vi.unstubAllEnvs();
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

const reply = "Read it: the file says hello.";

describe("Claude bridge tool results without a live query", () => {
	it("continues the turn with a fresh query instead of ending it empty", async () => {
		root = mkdtempSync(join(tmpdir(), "pi-claude-unowned-results-"));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		vi.stubEnv("HOME", root);
		vi.stubEnv("USERPROFILE", root);
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "claude"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const prompts: unknown[] = [];
		__test.setQuery((({ prompt }: { prompt: AsyncIterable<unknown> }) => {
			const stream = (async function* () {
				for await (const message of prompt) {
					prompts.push(message);
					break;
				}
				yield {
					type: "assistant",
					message: { content: [{ type: "text", text: reply }], usage: { input_tokens: 1, output_tokens: 1 } },
				};
				yield { type: "result", subtype: "success", is_error: false, result: reply };
			})();
			return Object.assign(stream, { interrupt: async () => {}, close: () => {} });
		}) as never);

		const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager,
			extensionFactories: [Object.assign(bridge, { extensionPath: "<first-party:claude-bridge>" })],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await resourceLoader.reload();
		const sessionManager = SessionManager.inMemory();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir,
			settingsManager,
			resourceLoader,
			authStorage: AuthStorage.inMemory(),
			sessionManager,
		});
		try {
			await session.bindExtensions({});
			const model = session.modelRegistry.getAll().find((entry) => entry.provider === "claude-bridge");
			if (!model) throw new Error("Bundled Claude provider did not register");
			await session.setModel(model);
			// The Claude query that asked for this read ended while Pi ran the tool (a long
			// wait, a detached tool, a new process); only Pi's history still has the call.
			const now = Date.now();
			session.agent.state.messages = [
				{ role: "user", content: [{ type: "text", text: "What does notes.txt say?" }], timestamp: now },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "toolu_read_1", name: "read", arguments: { path: "notes.txt" } }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: now,
				},
				{
					role: "toolResult",
					toolCallId: "toolu_read_1",
					toolName: "read",
					content: [{ type: "text", text: "hello" }],
					isError: false,
					timestamp: now,
				},
			];

			await session.continue();

			// The first reply after the tool result answers it; later turns are Pi's end_turn guard.
			const answer = session.messages.slice(3).find((message) => message.role === "assistant");
			expect(answer).toMatchObject({ role: "assistant", stopReason: "stop" });
			expect(answer?.role === "assistant" ? answer.content : []).toContainEqual({ type: "text", text: reply });
			expect(prompts[0]).toEqual(
				userMessage([{ type: "text", text: "[Continue the user's task from the completed tool results above.]" }]),
			);
		} finally {
			session.dispose();
		}
	});
});
