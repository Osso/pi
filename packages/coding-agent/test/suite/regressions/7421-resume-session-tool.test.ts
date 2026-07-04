import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { getControlDbPath, writeSessionMetadata } from "../../../src/core/session-control-db.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createResumeSessionToolDefinition } from "../../../src/core/tools/resume-session.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../../src/index.ts";

function getText(message: AgentSession["messages"][number]): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

const cleanups: Array<() => Promise<void> | void> = [];

function runtimeToolForTest() {
	return createResumeSessionToolDefinition();
}

afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

async function createRuntimeForTest(responses: string[], extensionFactory?: ExtensionFactory) {
	const tempDir = join(tmpdir(), `pi-resume-session-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const faux = registerFauxProvider({
		models: [{ id: "faux-1", reasoning: false }],
	});
	faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));

	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
						extensionFactory?.(pi);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel(),
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager: SessionManager.create(tempDir),
	});

	const rebindSession = async (): Promise<void> => {
		const session = runtime.session;
		await session.bindExtensions({
			commandContextActions: {
				showApprovalSelector: () => {},
				showSandboxSelector: () => {},
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (options) => runtime.newSession(options),
				fork: async (entryId, options) => {
					const result = await runtime.fork(entryId, options);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => runtime.switchSession(sessionPath, options),
				reload: async () => {
					await session.reload();
				},
				restart: async (options) => {
					await runtime.restart(options);
				},
			},
		});
	};

	runtime.setRebindSession(async () => {
		await rebindSession();
	});
	await rebindSession();

	cleanups.push(async () => {
		await runtime.dispose();
		faux.unregister();
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	return { runtime };
}

describe("resume_session first-party tool", () => {
	it("is active by default and warns that it replaces the current supervisor context", async () => {
		const { runtime } = await createRuntimeForTest([]);

		expect(runtime.session.getActiveToolNames()).toContain("resume_session");
		expect(runtime.session.getToolDefinition("resume_session")?.description).toContain(
			"replaces the current supervisor context",
		);
	});

	it("rejects child-agent contexts so only the main supervisor session can be replaced", async () => {
		const { runtime } = await createRuntimeForTest([]);
		const sessionPath = runtime.session.sessionFile;
		if (!sessionPath) throw new Error("Missing session path");
		const tool = runtime.session.getToolDefinition("resume_session");
		if (!tool) throw new Error("Missing resume_session tool");
		const childCtx = Object.create(runtime.session.extensionRunner.createContext()) as ExtensionContext;
		Object.defineProperty(childCtx, "multiAgentAgentId", { value: "agent_1" });

		await expect(
			tool.execute("resume-session-child-test", { path: sessionPath }, undefined, undefined, childCtx),
		).rejects.toThrow("resume_session is only available from the main supervisor session");
	});

	it("resolves target sessions by id and name", async () => {
		const { runtime } = await createRuntimeForTest(["root reply", "target reply"]);

		await runtime.session.prompt("root");
		const originalSessionPath = runtime.session.sessionFile;
		if (!originalSessionPath) throw new Error("Missing original session path");
		await runtime.newSession();
		await runtime.session.prompt("target");
		runtime.session.sessionManager.appendSessionInfo("named target");
		const targetSessionPath = runtime.session.sessionFile;
		if (!targetSessionPath) throw new Error("Missing target session path");
		const targetSessionId = runtime.session.sessionManager.getSessionId();
		await runtime.switchSession(originalSessionPath);

		const tool = runtime.session.getToolDefinition("resume_session");
		if (!tool) throw new Error("Missing resume_session tool");
		const idResult = await tool.execute(
			"resume-session-id-test",
			{ id: targetSessionId.slice(0, 12) },
			undefined,
			undefined,
			runtime.session.extensionRunner.createContext(),
		);
		await runtime.switchSession(originalSessionPath);
		const nameResult = await tool.execute(
			"resume-session-name-test",
			{ name: "named target" },
			undefined,
			undefined,
			runtime.session.extensionRunner.createContext(),
		);

		expect(idResult.details).toEqual({ cancelled: false, resumed: true, sessionPath: targetSessionPath });
		expect(nameResult.details).toEqual({ cancelled: false, resumed: true, sessionPath: targetSessionPath });
	});

	it("rejects missing and multiple targets", async () => {
		const { runtime } = await createRuntimeForTest([]);

		const tool = runtime.session.getToolDefinition("resume_session");
		if (!tool) throw new Error("Missing resume_session tool");
		const context = runtime.session.extensionRunner.createContext();

		await expect(tool.execute("missing", {}, undefined, undefined, context)).rejects.toThrow(
			"resume_session requires exactly one of path, id, or name",
		);
		await expect(
			tool.execute("multiple", { id: "target", path: "/tmp/session.jsonl" }, undefined, undefined, context),
		).rejects.toThrow("resume_session requires exactly one of path, id, or name");
	});

	it("rejects ambiguous named targets", async () => {
		const { runtime } = await createRuntimeForTest(["root reply", "first reply", "second reply"]);

		await runtime.session.prompt("root");
		const originalSessionPath = runtime.session.sessionFile;
		if (!originalSessionPath) throw new Error("Missing original session path");
		await runtime.newSession();
		await runtime.session.prompt("first");
		runtime.session.sessionManager.appendSessionInfo("duplicate target");
		await runtime.newSession();
		await runtime.session.prompt("second");
		runtime.session.sessionManager.appendSessionInfo("duplicate target");
		await runtime.switchSession(originalSessionPath);

		const tool = runtime.session.getToolDefinition("resume_session");
		if (!tool) throw new Error("Missing resume_session tool");
		await expect(
			tool.execute(
				"ambiguous-name",
				{ name: "duplicate target" },
				undefined,
				undefined,
				runtime.session.extensionRunner.createContext(),
			),
		).rejects.toThrow("Ambiguous session match for name 'duplicate target'");
	});

	it("rejects id and name targets whose metadata points at missing session files", async () => {
		const root = join(tmpdir(), `pi-resume-session-stale-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const currentCwd = join(root, "current");
		const sessionDir = join(root, "sessions");
		mkdirSync(currentCwd, { recursive: true });
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const current = SessionManager.create(currentCwd, sessionDir, { id: "current-session" });
		const controlDbPath = getControlDbPath(root);
		const stalePath = join(sessionDir, "stale-session.jsonl");
		writeSessionMetadata(controlDbPath, {
			allMessagesText: "stale",
			createdAt: "2026-07-04T00:00:00.000Z",
			cwd: currentCwd,
			firstMessage: "stale",
			id: "019f7421-stale-7000-8000-000000000001",
			messageCount: 1,
			modifiedAt: "2026-07-04T00:00:00.000Z",
			name: "stale target",
			parentSessionPath: undefined,
			sessionPath: stalePath,
		});
		const context = {
			controlDbPath,
			cwd: currentCwd,
			sessionManager: current,
			switchSession: async () => ({ cancelled: false }),
		} as unknown as ExtensionContext;
		const tool = runtimeToolForTest();

		await expect(tool.execute("stale-id", { id: "019f7421-stale" }, undefined, undefined, context)).rejects.toThrow(
			`Session file does not exist: ${stalePath}`,
		);
		await expect(tool.execute("stale-name", { name: "stale target" }, undefined, undefined, context)).rejects.toThrow(
			`Session file does not exist: ${stalePath}`,
		);
	});

	it("resolves id targets across a custom session directory", async () => {
		const root = join(tmpdir(), `pi-resume-session-custom-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const currentCwd = join(root, "current");
		const targetCwd = join(root, "target");
		const sessionDir = join(root, "sessions");
		mkdirSync(currentCwd, { recursive: true });
		mkdirSync(targetCwd, { recursive: true });
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const current = SessionManager.create(currentCwd, sessionDir);
		const target = SessionManager.create(targetCwd, sessionDir, { id: "019f7421-1000-7000-8000-000000000001" });
		target.appendMessage({ role: "user", content: "target", timestamp: 1 });
		target.appendMessage(fauxAssistantMessage("target reply"));
		let switchedPath = "";
		const context = {
			cwd: currentCwd,
			sessionManager: current,
			switchSession: async (sessionPath: string) => {
				switchedPath = sessionPath;
				return { cancelled: false };
			},
		} as unknown as ExtensionContext;

		const tool = runtimeToolForTest();
		const result = await tool.execute("custom-dir-id", { id: "019f7421-1000" }, undefined, undefined, context);

		expect(switchedPath).toBe(target.getSessionFile());
		expect(result.details).toEqual({ cancelled: false, resumed: true, sessionPath: target.getSessionFile() });
	});

	it("switches to a target session by path and sends an optional starter prompt in the resumed session", async () => {
		const { runtime } = await createRuntimeForTest(["root reply", "target reply", "starter reply"]);

		await runtime.session.prompt("root");
		const originalSessionPath = runtime.session.sessionFile;
		if (!originalSessionPath) throw new Error("Missing original session path");
		await runtime.newSession();
		await runtime.session.prompt("target");
		const targetSessionPath = runtime.session.sessionFile;
		if (!targetSessionPath) throw new Error("Missing target session path");
		await runtime.switchSession(originalSessionPath);

		const tool = runtime.session.getToolDefinition("resume_session");
		if (!tool) throw new Error("Missing resume_session tool");
		const result = await tool.execute(
			"resume-session-test",
			{ path: targetSessionPath, starter_prompt: "continue in target" },
			undefined,
			undefined,
			runtime.session.extensionRunner.createContext(),
		);

		expect(result.details).toEqual({ cancelled: false, resumed: true, sessionPath: targetSessionPath });
		expect(runtime.session.sessionFile).toBe(targetSessionPath);
		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"user:target",
			"assistant:target reply",
			"user:continue in target",
			"assistant:starter reply",
		]);
	});

	it("does not send the starter prompt when a session_before_switch hook cancels resume", async () => {
		const { runtime } = await createRuntimeForTest(["root reply", "target reply"], (pi) => {
			pi.on("session_before_switch", (event) => {
				if (event.reason === "resume") return { cancel: true };
				return undefined;
			});
		});

		await runtime.session.prompt("root");
		const originalSessionPath = runtime.session.sessionFile;
		if (!originalSessionPath) throw new Error("Missing original session path");
		await runtime.newSession();
		await runtime.session.prompt("target");
		const targetSessionPath = runtime.session.sessionFile;
		if (!targetSessionPath) throw new Error("Missing target session path");

		const tool = runtime.session.getToolDefinition("resume_session");
		if (!tool) throw new Error("Missing resume_session tool");
		const result = await tool.execute(
			"resume-session-cancel-test",
			{ path: originalSessionPath, starter_prompt: "should not send" },
			undefined,
			undefined,
			runtime.session.extensionRunner.createContext(),
		);

		expect(result.details).toEqual({ cancelled: true, resumed: false, sessionPath: originalSessionPath });
		expect(runtime.session.sessionFile).toBe(targetSessionPath);
		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"user:target",
			"assistant:target reply",
		]);
	});
});
