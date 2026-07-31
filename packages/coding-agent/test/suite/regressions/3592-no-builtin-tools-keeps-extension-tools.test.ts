import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

describe("regression #3592: no-builtin-tools keeps extension tools enabled", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-no-builtin-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(options?: { noTools?: "all" | "builtin"; tools?: string[]; excludeTools?: string[] }) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Tool registered from session_start",
							promptSnippet: "Run dynamic test behavior",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			noTools: options?.noTools,
			tools: options?.tools,
			excludeTools: options?.excludeTools,
		});
		await session.bindExtensions({});
		return session;
	}

	it("keeps extension tools active when built-in defaults are disabled", async () => {
		const session = await createSession({ noTools: "builtin" });

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual([
			"ask_architect",
			"ask_questions",
			"ask_supervisor",
			"bash",
			"broadcast",
			"change_working_directory",
			"channel_post",
			"dynamic_tool",
			"edit",
			"end_turn",
			"find",
			"grep",
			"list_sessions",
			"ls",
			"outline",
			"read",
			"references",
			"resume_session",
			"search_current_session_history",
			"symbol",
			"write",
		]);
		expect(session.getActiveToolNames()).toEqual(["end_turn", "dynamic_tool"]);
		expect(session.systemPrompt).toContain("- dynamic_tool: Run dynamic test behavior");
		expect(session.systemPrompt).not.toContain("- read:");
		expect(session.systemPrompt).not.toContain("- bash:");
		expect(session.systemPrompt).toContain("- end_turn:");
		session.dispose();
	});

	it("keeps end_turn active when noTools is all", async () => {
		const session = await createSession({ noTools: "all" });

		expect(session.getAllTools().map((tool) => tool.name)).toEqual(["end_turn"]);
		expect(session.getActiveToolNames()).toEqual(["end_turn"]);
		expect(session.systemPrompt).toContain("- end_turn:");
		session.dispose();
	});

	it("propagates noTools through service-based session creation", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			noTools: "builtin",
		});

		expect(session.getActiveToolNames()).toEqual(["end_turn"]);
		expect(session.systemPrompt).toContain("- end_turn:");
		expect(session.systemPrompt).not.toContain("- read:");
		session.dispose();
	});

	it("keeps end_turn outside an explicit allowlist and exclude list", async () => {
		const session = await createSession({ tools: ["read"], excludeTools: ["end_turn"] });

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["end_turn", "read"]);
		expect(session.getActiveToolNames().sort()).toEqual(["end_turn", "read"]);
		session.dispose();
	});
});
