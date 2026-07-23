import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentSession, shouldContinueInterruptedSession } from "../../../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import {
	getControlDbPath,
	readRuntimeMailboxListener,
	writeSessionMetadata,
} from "../../../src/core/session-control-db.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createSqliteDatabase } from "../../../src/core/sqlite.ts";
import { createResumeSessionToolDefinition } from "../../../src/core/tools/resume-session.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../../src/index.ts";
import { type HeadlessPiPaths, withHeadlessPi } from "../headless-pi.ts";

function getText(message: AgentSession["messages"][number]): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

const cleanups: Array<() => Promise<void> | void> = [];

function buildInteractivePiArguments(sessionFile: string): string[] {
	const cliPath = join(import.meta.dirname, "../../../src/cli.ts");
	const providerPreload = join(import.meta.dirname, "../fixtures/headless-pi-provider-preload.ts");
	const ttyPreload = join(import.meta.dirname, "../fixtures/headless-pi-tty-preload.mjs");
	return [
		"--import",
		import.meta.resolve("tsx"),
		"--import",
		pathToFileURL(providerPreload).href,
		"--import",
		pathToFileURL(ttyPreload).href,
		cliPath,
		"--approve",
		"--no-context-files",
		"--no-skills",
		"--no-themes",
		"--provider",
		"headless-faux",
		"--model",
		"headless-faux-1",
		"--session",
		sessionFile,
	];
}

function buildInteractivePiEnvironment(paths: HeadlessPiPaths): NodeJS.ProcessEnv {
	return {
		...process.env,
		NO_COLOR: "1",
		PI_CODING_AGENT_DIR: paths.agentDir,
		PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
		PI_CODING_AGENT_STATE_DIR: paths.agentDir,
		PI_HEADLESS_PROVIDER_SOCKET: join(paths.tempDir, "provider.sock"),
		TERM: "xterm-256color",
	};
}

function captureProcessOutput(child: ChildProcessWithoutNullStreams): () => string {
	let output = "";
	const appendOutput = (chunk: Buffer) => {
		output += chunk.toString();
	};
	child.stdout.on("data", appendOutput);
	child.stderr.on("data", appendOutput);
	return () => output;
}

function startInteractivePi(
	paths: HeadlessPiPaths,
	sessionFile: string,
): {
	process: ChildProcessWithoutNullStreams;
	readOutput: () => string;
} {
	const child = spawn(process.execPath, buildInteractivePiArguments(sessionFile), {
		cwd: paths.workspaceDir,
		env: buildInteractivePiEnvironment(paths),
	});
	return { process: child, readOutput: captureProcessOutput(child) };
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGTERM");
	await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await exited;
	}
}

async function waitForRuntimeListener(
	controlDbPath: string,
	sessionId: string,
	process: ChildProcessWithoutNullStreams,
	readOutput: () => string,
): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (readRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId })?.pid === process.pid) return;
		if (process.exitCode !== null || process.signalCode !== null) {
			throw new Error(`Interactive Pi exited before registering its runtime listener:\n${readOutput()}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for interactive Pi runtime listener:\n${readOutput()}`);
}

async function waitForInteractiveOutput(
	process: ChildProcessWithoutNullStreams,
	readOutput: () => string,
	text: string,
): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (readOutput().includes(text)) return;
		if (process.exitCode !== null || process.signalCode !== null) {
			throw new Error(`Interactive Pi exited before rendering '${text}':\n${readOutput()}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for interactive Pi to render '${text}':\n${readOutput()}`);
}

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
	it("does not classify a trailing resume_session call as interrupted work", () => {
		const resumeCall = fauxAssistantMessage(
			fauxToolCall("resume_session", { path: "/sessions/target.jsonl" }, { id: "resume-before-exit" }),
		);
		const ordinaryCall = fauxAssistantMessage(
			fauxToolCall("read", { path: "/tmp/file" }, { id: "read-before-exit" }),
		);

		expect(shouldContinueInterruptedSession([resumeCall])).toBe(false);
		expect(shouldContinueInterruptedSession([ordinaryCall])).toBe(true);
	});

	it("keeps a restored source alive without replaying its completed switch", async () => {
		await withHeadlessPi(async (target) => {
			if (!existsSync(target.sessionFile)) {
				writeFileSync(
					target.sessionFile,
					`${JSON.stringify({
						type: "session",
						version: 3,
						id: target.sessionId,
						timestamp: new Date().toISOString(),
						cwd: target.paths.workspaceDir,
					})}\n`,
				);
			}
			const sourceSession = SessionManager.create(target.paths.workspaceDir, target.paths.sessionDir);
			sourceSession.appendMessage({ role: "user", content: "Switch to live target", timestamp: Date.now() });
			sourceSession.appendMessage(
				fauxAssistantMessage(
					fauxToolCall(
						"resume_session",
						{
							id: target.sessionId,
							starter_prompt: "Resume target after restart without changing task scope.",
						},
						{ id: "resume-before-process-exit" },
					),
					{ stopReason: "toolUse" },
				),
			);
			const sourceSessionFile = sourceSession.getSessionFile();
			if (!sourceSessionFile) throw new Error("Missing source session file");
			const interactive = startInteractivePi(target.paths, sourceSessionFile);
			cleanups.push(() => stopProcess(interactive.process));

			const controlDbPath = getControlDbPath(target.paths.agentDir);
			await waitForRuntimeListener(
				controlDbPath,
				sourceSession.getSessionId(),
				interactive.process,
				interactive.readOutput,
			);
			await waitForInteractiveOutput(interactive.process, interactive.readOutput, "headless-faux-1");
			await new Promise((resolve) => setTimeout(resolve, 1_000));

			expect(interactive.process.exitCode, interactive.readOutput()).toBeNull();
			expect(
				readRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: sourceSession.getSessionId() }),
			).toMatchObject({ pid: interactive.process.pid, sessionPath: sourceSessionFile });
			expect(
				SessionManager.open(sourceSessionFile)
					.getEntries()
					.find(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.toolCallId === "resume-before-process-exit",
					),
				interactive.readOutput(),
			).toBeUndefined();
		});
	});

	it("keeps the caller alive when the target session is already open", async () => {
		await withHeadlessPi(async (caller) => {
			const targetSession = SessionManager.create(caller.paths.workspaceDir, caller.paths.sessionDir);
			targetSession.appendMessage({ role: "user", content: "Live target", timestamp: Date.now() });
			const targetSessionFile = targetSession.getSessionFile();
			if (!targetSessionFile) throw new Error("Missing target session file");
			const target = await caller.startSharedSession({ sessionFile: targetSessionFile });
			if (!existsSync(target.sessionFile)) {
				writeFileSync(
					target.sessionFile,
					`${JSON.stringify({ type: "session", version: 3, id: target.sessionId, timestamp: new Date().toISOString(), cwd: caller.paths.workspaceDir })}\n`,
				);
			}
			const callerRecipient = { agentId: null, sessionId: caller.sessionId };
			const controlDbPath = getControlDbPath(caller.paths.agentDir);

			await caller.send({ type: "prompt", message: "Resume the live target" });
			const request = await caller.waitForLlmRequest();
			caller.respondToLlmRequest(
				request.id,
				fauxAssistantMessage(
					fauxToolCall("resume_session", { path: target.sessionFile }, { id: "resume-live-target" }),
				),
			);

			const afterRejection = await caller.waitForLlmRequest((candidate) => candidate.id !== request.id);
			expect(JSON.stringify(afterRejection.messages)).toContain("open in another Pi process");
			expect(readRuntimeMailboxListener(controlDbPath, callerRecipient)?.sessionPath).toBe(caller.sessionFile);

			caller.respondToLlmRequest(afterRejection.id, fauxAssistantMessage("Caller remains active"));
			await caller.waitForEvent((event) => event.type === "agent_end");
		});
	});

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

	it("rejects resuming the current session by path, id, or name", async () => {
		const { runtime } = await createRuntimeForTest(["root reply"]);
		await runtime.session.prompt("root");
		runtime.session.sessionManager.appendSessionInfo("current session");
		const sessionPath = runtime.session.sessionFile;
		if (!sessionPath) throw new Error("Missing session path");
		const sessionId = runtime.session.sessionManager.getSessionId();
		const tool = runtime.session.getToolDefinition("resume_session");
		if (!tool) throw new Error("Missing resume_session tool");
		const context = runtime.session.extensionRunner.createContext();

		for (const target of [{ path: sessionPath }, { id: sessionId }, { name: "current session" }]) {
			await expect(tool.execute("self-resume", target, undefined, undefined, context)).rejects.toThrow(
				"resume_session cannot resume the current session",
			);
		}

		expect(runtime.session.sessionFile).toBe(sessionPath);
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
			{ id: targetSessionId.slice(0, 20) },
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

	it("resolves an id without materializing unrelated session metadata", async () => {
		const root = join(tmpdir(), `pi-resume-session-bounded-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const currentCwd = join(root, "current");
		const targetCwd = join(root, "target");
		const sessionDir = join(root, "sessions");
		mkdirSync(currentCwd, { recursive: true });
		mkdirSync(targetCwd, { recursive: true });
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const current = SessionManager.create(currentCwd, sessionDir, { id: "current-session" });
		const target = SessionManager.create(targetCwd, sessionDir, { id: "019f7421-2000-7000-8000-000000000001" });
		target.appendMessage({ role: "user", content: "target", timestamp: 1 });
		const targetPath = target.getSessionFile();
		if (!targetPath) throw new Error("Missing target session path");
		writeFileSync(targetPath, "");
		const controlDbPath = getControlDbPath(root);
		writeSessionMetadata(controlDbPath, {
			allMessagesText: "target",
			createdAt: "2026-07-16T00:00:00.000Z",
			cwd: targetCwd,
			firstMessage: "target",
			id: target.getSessionId(),
			messageCount: 1,
			modifiedAt: "2026-07-16T00:00:00.000Z",
			name: undefined,
			parentSessionPath: undefined,
			sessionPath: targetPath,
		});
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec("BEGIN");
			const insert = db.prepare(`
				INSERT INTO session_metadata (
					session_path, id, cwd, name, parent_session_path, archived_at, goal_json,
					is_subagent, subagent_name, created_at, modified_at, message_count,
					first_message, all_messages_text, updated_at
				) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, 0, NULL, ?, ?, 1, ?, ?, ?)
			`);
			const largeMessage = "x".repeat(8192);
			for (let index = 0; index < 5_000; index += 1) {
				const timestamp = "2026-07-15T00:00:00.000Z";
				insert.run(
					join(sessionDir, `unrelated-${index}.jsonl`),
					`unrelated-${index}`,
					targetCwd,
					timestamp,
					timestamp,
					"unrelated",
					largeMessage,
					timestamp,
				);
			}
			db.exec("COMMIT");
		} finally {
			db.close();
		}
		let switchedPath = "";
		const context = {
			controlDbPath,
			cwd: currentCwd,
			sessionManager: current,
			switchSession: async (sessionPath: string) => {
				switchedPath = sessionPath;
				return { cancelled: false };
			},
		} as unknown as ExtensionContext;

		const startedAt = performance.now();
		await runtimeToolForTest().execute("bounded-id", { id: "019f7421-2000" }, undefined, undefined, context);
		const elapsedMs = performance.now() - startedAt;

		expect(switchedPath).toBe(targetPath);
		expect(elapsedMs).toBeLessThan(100);
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
