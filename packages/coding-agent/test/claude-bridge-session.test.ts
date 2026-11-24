import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionPath, normalizeProjectPath } from "cc-session-io";
import { afterEach, describe, expect, it, vi } from "vitest";
import bridge, { __test } from "../extensions/claude-bridge/src/index.ts";
import { recordedNativeSession, recordNativeSession } from "../extensions/claude-bridge/src/native-prefix.ts";
import {
	sessionStateFor,
	setSessionStateFor,
	syncSharedSession,
} from "../extensions/claude-bridge/src/session-mirror.ts";
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

describe("bundled Claude session", () => {
	it("runs a Pi prompt with its project context through the bundled provider without a separate package", async () => {
		root = mkdtempSync(join(tmpdir(), "pi-bundled-claude-session-"));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		vi.stubEnv("HOME", root);
		vi.stubEnv("USERPROFILE", root);
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "claude"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		writeFileSync(join(root, "AGENTS.md"), "Project sentinel: bridge-context-fixture.");
		const requests: Array<{ systemPrompt: { append?: string }; tools: string[] }> = [];
		const fakeQuery = ({ options }: { options: (typeof requests)[number] }) => {
			requests.push(options);
			const stream = (async function* () {
				yield {
					type: "assistant",
					message: {
						content: [{ type: "text", text: "Bundled Claude fixture reply." }],
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				};
				yield { type: "result", subtype: "success", is_error: false, result: "Bundled Claude fixture reply." };
			})();
			return Object.assign(stream, { interrupt: async () => {}, close: () => {} });
		};
		__test.setQuery(fakeQuery as never);
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
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		const { session } = await createAgentSession({
			cwd: root,
			agentDir,
			settingsManager,
			resourceLoader,
			authStorage: AuthStorage.inMemory(),
			sessionManager: SessionManager.inMemory(),
		});
		try {
			await session.bindExtensions({});
			const model = session.modelRegistry.getAll().find((entry) => entry.provider === "claude-bridge");
			expect(model).toBeDefined();
			if (!model) throw new Error("Bundled Claude provider did not register");
			await session.setModel(model);
			await session.prompt("Reply using the project sentinel.");
			const reply = session.messages.filter((message) => message.role === "assistant").at(-1);
			const replyTexts = reply?.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
			expect(replyTexts).toEqual(["Bundled Claude fixture reply."]);
			expect(requests).toContainEqual(
				expect.objectContaining({
					tools: ["WebSearch"],
					systemPrompt: expect.objectContaining({ append: expect.stringContaining("bridge-context-fixture") }),
				}),
			);
		} finally {
			session.dispose();
		}
	});

	it("returns undefined instead of throwing when a recorded native session hint is corrupt or non-object JSON", () => {
		root = mkdtempSync(join(tmpdir(), "pi-native-prefix-corrupt-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", root);
		recordNativeSession("pi-sess-1", "cc-sess-1", "/repo");
		expect(recordedNativeSession("pi-sess-1", "/repo")).toBe("cc-sess-1");

		const hintFile = join(root, "claude-bridge-sessions", "pi-sess-1.json");
		writeFileSync(hintFile, "{bad-json");
		expect(recordedNativeSession("pi-sess-1", "/repo")).toBeUndefined();

		writeFileSync(hintFile, "null");
		expect(recordedNativeSession("pi-sess-1", "/repo")).toBeUndefined();
	});

	it("rebuilds the Claude transcript in the new project after the session working directory changes", () => {
		root = mkdtempSync(join(tmpdir(), "pi-claude-mirror-cwd-"));
		const claudeDir = join(root, "claude");
		const repoA = join(root, "repo-a");
		const repoB = join(root, "repo-b");
		mkdirSync(repoA);
		mkdirSync(repoB);
		vi.stubEnv("CLAUDE_CONFIG_DIR", claudeDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
		const remember = { role: "user" as const, content: "Remember the blue notebook.", timestamp: 1 };
		const reply = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "I will remember the blue notebook." }],
			api: "anthropic-messages" as const,
			provider: "claude-bridge",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 2,
		};
		const question = { role: "user" as const, content: "What did I ask you to remember?", timestamp: 3 };
		syncSharedSession([remember, reply, question], repoA, new Map(), undefined, "pi-session-cwd");
		const before = sessionStateFor("pi-session-cwd");
		expect(before?.cwd).toBe(repoA);
		// As after the query completes: the mirror now covers the whole first turn.
		if (before) setSessionStateFor("pi-session-cwd", { ...before, cursor: 3 });

		syncSharedSession([remember, reply, question, reply, question], repoB, new Map(), undefined, "pi-session-cwd");

		const state = sessionStateFor("pi-session-cwd");
		expect(state?.cwd).toBe(repoB);
		expect(existsSync(getSessionPath(state?.sessionId ?? "", normalizeProjectPath(repoB), claudeDir))).toBe(true);
	});
});
