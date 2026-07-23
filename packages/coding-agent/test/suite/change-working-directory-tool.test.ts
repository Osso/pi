import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { getControlDbPath } from "../../src/core/session-control-db.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ExtensionAPI, ExtensionCommandContextActions } from "../../src/index.ts";
import { withHeadlessPi } from "./headless-pi.ts";

interface RelocateCommandContextActions extends ExtensionCommandContextActions {
	relocate(targetCwd: string): Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

function defaultSessionDir(cwd: string, agentDir: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(agentDir, "sessions", safePath);
}

async function createRuntimeForTest() {
	const tempDir = join(tmpdir(), `pi-change-working-directory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
	const controlDbPath = getControlDbPath(tempDir);

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
							models: faux.models.map((model) => ({
								id: model.id,
								name: model.name,
								api: model.api,
								reasoning: model.reasoning,
								input: model.input,
								cost: model.cost,
								contextWindow: model.contextWindow,
								maxTokens: model.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		sessionManager.setMetadataControlDbPath(controlDbPath);
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
		sessionManager: SessionManager.create(tempDir, defaultSessionDir(tempDir, tempDir)),
	});

	const rebindSession = async (): Promise<void> => {
		const session = runtime.session;
		const commandContextActions: RelocateCommandContextActions = {
			showApprovalSelector: () => {},
			showSandboxSelector: () => {},
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: async (options) => runtime.newSession(options),
			fork: async (entryId, options) => {
				const result = await runtime.fork(entryId, options);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await session.navigateTree(targetId, options);
				return { cancelled: result.cancelled };
			},
			switchSession: async (sessionPath, options) => runtime.switchSession(sessionPath, options),
			reload: async () => {
				await session.reload();
			},
			restart: async (options) => {
				await runtime.restart(options);
			},
			relocate: async (targetCwd) => {
				await runtime.relocate(targetCwd);
			},
		};
		await session.bindExtensions({ controlDbPath, commandContextActions });
	};

	runtime.setRebindSession(rebindSession);
	await rebindSession();

	cleanups.push(async () => {
		await runtime.dispose();
		faux.unregister();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	return { controlDbPath, runtime, tempDir };
}

function getChangeWorkingDirectoryTool(runtime: Awaited<ReturnType<typeof createRuntimeForTest>>["runtime"]) {
	const tool = runtime.session.getToolDefinition("change_working_directory");
	if (!tool) throw new Error("Missing change_working_directory tool");
	return tool;
}

function readTextContent(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

describe("change_working_directory first-party tool", () => {
	it("changes the current session cwd from a direct directory path without changing session identity", async () => {
		const { runtime, tempDir } = await createRuntimeForTest();
		const targetCwd = join(tempDir, "direct-target");
		mkdirSync(targetCwd);
		const sessionId = runtime.session.sessionId;

		await getChangeWorkingDirectoryTool(runtime).execute(
			"change-cwd-path",
			{ path: targetCwd },
			undefined,
			undefined,
			runtime.session.extensionRunner.createContext(),
		);

		expect(runtime.session.sessionId).toBe(sessionId);
		expect(runtime.cwd).toBe(targetCwd);
		expect(runtime.session.sessionManager.getCwd()).toBe(targetCwd);
	});

	it("preserves whitespace in a direct directory path", async () => {
		const { runtime, tempDir } = await createRuntimeForTest();
		const targetCwd = join(tempDir, " target with whitespace ");
		mkdirSync(targetCwd);

		await getChangeWorkingDirectoryTool(runtime).execute(
			"change-cwd-whitespace-path",
			{ path: targetCwd },
			undefined,
			undefined,
			runtime.session.extensionRunner.createContext(),
		);

		expect(runtime.cwd).toBe(targetCwd);
		expect(runtime.session.sessionManager.getCwd()).toBe(targetCwd);
	});

	it("resolves a session id to its recorded cwd without resuming that session", async () => {
		const { controlDbPath, runtime, tempDir } = await createRuntimeForTest();
		const targetCwd = join(tempDir, "tradebot");
		mkdirSync(targetCwd);
		const target = SessionManager.create(targetCwd, defaultSessionDir(targetCwd, tempDir), {
			id: "019f8def-4d62-7d88-9690-9e450ee71d64",
		});
		target.setMetadataControlDbPath(controlDbPath);
		target.appendMessage({ role: "user", content: "Tradebot work", timestamp: Date.now() });
		target.appendMessage(fauxAssistantMessage("Tradebot reply"));
		const targetSessionFile = target.getSessionFile();
		if (!targetSessionFile) throw new Error("Target session file was not created");
		const targetLines = readFileSync(targetSessionFile, "utf8").trimEnd().split("\n");
		const legacyHeader = {
			...JSON.parse(targetLines[0] ?? "{}"),
			version: 2,
			parentSession: `/${"nested-session/".repeat(40)}`,
		};
		const legacyTargetContent = `${[JSON.stringify(legacyHeader), ...targetLines.slice(1)].join("\n")}\n`;
		writeFileSync(targetSessionFile, legacyTargetContent);
		const currentSessionId = runtime.session.sessionId;
		const currentSessionFile = runtime.session.sessionFile;

		await getChangeWorkingDirectoryTool(runtime).execute(
			"change-cwd-session-id",
			{ id: target.getSessionId() },
			undefined,
			undefined,
			runtime.session.extensionRunner.createContext(),
		);

		expect(runtime.session.sessionId).toBe(currentSessionId);
		expect(runtime.session.sessionFile).not.toBe(targetSessionFile);
		expect(runtime.session.sessionFile).not.toBe(currentSessionFile);
		expect(runtime.cwd).toBe(targetCwd);
		expect(readFileSync(targetSessionFile, "utf8")).toBe(legacyTargetContent);
	});

	it("rejects a current session id prefix without modifying the session", async () => {
		const { runtime } = await createRuntimeForTest();
		runtime.session.sessionManager.appendMessage({ role: "user", content: "Current work", timestamp: Date.now() });
		const originalCwd = runtime.cwd;
		const originalEntryCount = runtime.session.sessionManager.getEntries().length;
		const currentSessionIdPrefix = runtime.session.sessionId.slice(0, 8);

		await expect(
			getChangeWorkingDirectoryTool(runtime).execute(
				"change-cwd-current-session",
				{ id: currentSessionIdPrefix },
				undefined,
				undefined,
				runtime.session.extensionRunner.createContext(),
			),
		).rejects.toThrow("current session id cannot be used as a working directory target");

		expect(runtime.cwd).toBe(originalCwd);
		expect(runtime.session.sessionManager.getEntries()).toHaveLength(originalEntryCount);
	});

	it("rejects a missing directory without changing cwd", async () => {
		const { runtime, tempDir } = await createRuntimeForTest();
		const missingCwd = join(tempDir, "missing");

		await expect(
			getChangeWorkingDirectoryTool(runtime).execute(
				"change-cwd-missing",
				{ path: missingCwd },
				undefined,
				undefined,
				runtime.session.extensionRunner.createContext(),
			),
		).rejects.toThrow(`Directory does not exist: ${missingCwd}`);

		expect(runtime.cwd).toBe(tempDir);
	});

	it("rebuilds relative-path tools for the changed cwd", async () => {
		const { runtime, tempDir } = await createRuntimeForTest();
		const targetCwd = join(tempDir, "relative-target");
		mkdirSync(targetCwd);
		writeFileSync(join(targetCwd, "marker.txt"), "relative tool used changed cwd");

		await getChangeWorkingDirectoryTool(runtime).execute(
			"change-cwd-relative",
			{ path: targetCwd },
			undefined,
			undefined,
			runtime.session.extensionRunner.createContext(),
		);

		const readTool = runtime.session.getToolDefinition("read");
		if (!readTool) throw new Error("Missing read tool");
		const result = await readTool.execute(
			"read-relative-after-cwd-change",
			{ path: "marker.txt" },
			undefined,
			undefined,
			runtime.session.extensionRunner.createContext(),
		);

		expect(readTextContent(result.content)).toContain("relative tool used changed cwd");
	});

	it("persists the changed cwd across a real process restart", async () => {
		await withHeadlessPi(async (agent) => {
			const targetCwd = join(agent.paths.tempDir, "restart-target");
			mkdirSync(targetCwd);
			writeFileSync(join(targetCwd, "restart-marker.txt"), "cwd survived process restart");

			await agent.send({ type: "prompt", message: "Change working directory" });
			const changeRequest = await agent.waitForLlmRequest();
			agent.respondToLlmRequest(
				changeRequest.id,
				fauxAssistantMessage(
					fauxToolCall("change_working_directory", { path: targetCwd }, { id: "change-cwd-before-restart" }),
				),
			);
			await agent.waitForSessionEntry(
				null,
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "cwd_changed" &&
					typeof entry.content === "string" &&
					entry.content.includes(targetCwd),
			);

			await agent.send({ type: "prompt", message: "Acknowledge the changed cwd" });
			const settledRequest = await agent.waitForLlmRequest();
			agent.respondToLlmRequest(settledRequest.id, fauxAssistantMessage("replacement runtime settled"));
			await agent.waitForSessionEntry(
				null,
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					readTextContent(entry.message.content).includes("replacement runtime settled"),
			);

			expect(SessionManager.open(agent.sessionFile).getCwd()).toBe(targetCwd);
			await agent.restart();
			expect(SessionManager.open(agent.sessionFile).getCwd()).toBe(targetCwd);

			await agent.send({ type: "prompt", message: "Read restart-marker.txt" });
			const readRequest = await agent.waitForLlmRequest();
			agent.respondToLlmRequest(
				readRequest.id,
				fauxAssistantMessage(
					fauxToolCall("read", { path: "restart-marker.txt" }, { id: "read-after-cwd-restart" }),
				),
			);
			const readFollowUp = await agent.waitForLlmRequest((request) => request.id !== readRequest.id);

			expect(JSON.stringify(readFollowUp.messages)).toContain("cwd survived process restart");
			agent.respondToLlmRequest(readFollowUp.id, fauxAssistantMessage("restart read complete"));
			await agent.waitForSessionEntry(
				null,
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					readTextContent(entry.message.content).includes("restart read complete"),
			);

			const persistedHeader = JSON.parse(readFileSync(agent.sessionFile, "utf8").split("\n")[0] ?? "{}") as {
				cwd?: string;
			};
			expect(persistedHeader.cwd).toBe(targetCwd);
			expect(basename(agent.sessionFile)).toContain(agent.sessionId);
		});
	});
});
