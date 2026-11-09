import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import bridge, { __test } from "../extensions/claude-bridge/src/index.ts";
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
			expect(reply?.content).toContainEqual({ type: "text", text: "Bundled Claude fixture reply." });
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
});
