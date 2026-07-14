import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getAgentDir } from "../config.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import { ModelRegistry } from "../core/model-registry.ts";
import { DefaultResourceLoader } from "../core/resource-loader.ts";
import { createAgentSession } from "../core/sdk.ts";
import {
	archiveSession,
	claimNextSupervisorRequest,
	completeSupervisorRequest,
	getControlDbPath,
	recoverSupervisorRequests,
	type SupervisorRequest,
} from "../core/session-control-db.ts";
import { SessionManager } from "../core/session-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { DEFAULT_SUPERVISOR_KB_DIR } from "./project-resolver.ts";
import { runSupervisorRequest } from "./service.ts";

const SUPERVISOR_SESSION_ID = "supervisor";
const REQUEST_POLL_INTERVAL_MS = 100;

export const SUPERVISOR_EXCLUDED_TOOL_NAMES = [
	"ask_architect",
	"attach_session_agent",
	"bash",
	"channel_post",
	"contact_supervisor",
	"loop",
	"manage_goal",
	"pyrun_eval",
	"restart_self",
	"resume_session",
	"send_agent_message",
	"spawn_agent",
];

export function createSupervisorSettingsManager(): SettingsManager {
	return SettingsManager.inMemory({
		approvalPolicy: "auto-approve",
		approvalPreset: "auto-approve",
		sandboxProfile: "full-access",
	});
}

export function blockSupervisorMutation(
	kbDir: string,
	event: { input: unknown; toolName: string },
): { block: true; reason: string } | undefined {
	if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
	const path = readToolPath(event.input);
	if (path && isPathWithinRoot(resolve(kbDir, path), resolve(kbDir))) return undefined;
	return { block: true, reason: "Pi Supervisor may write only inside the configured KB directory." };
}

export async function runSupervisorService(): Promise<void> {
	const agentDir = getAgentDir();
	const kbDir = process.env.PI_KB_DIR ?? DEFAULT_SUPERVISOR_KB_DIR;
	const sessionManager = openSupervisorSession(agentDir, kbDir);
	const controlDbPath = getControlDbPath(agentDir);
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	const model = modelRegistry.find("openai-codex", "gpt-5.6-sol");
	if (!model) throw new Error("Pi Supervisor requires openai-codex/gpt-5.6-sol");
	const settingsManager = createSupervisorSettingsManager();
	const resourceLoader = new DefaultResourceLoader({
		agentDir,
		cwd: kbDir,
		extensionFactories: [
			(pi) => {
				pi.registerToolGate((event) => blockSupervisorMutation(kbDir, event));
			},
		],
		noContextFiles: true,
		noExtensions: true,
		noPromptTemplates: true,
		noSkills: true,
		noThemes: true,
		settingsManager,
	});
	const { session } = await createAgentSession({
		agentDir,
		authStorage,
		cwd: kbDir,
		disableRuntimeCoordinationInbound: true,
		excludeTools: SUPERVISOR_EXCLUDED_TOOL_NAMES,
		model,
		modelRegistry,
		resourceLoader,
		sessionManager,
		settingsManager,
		thinkingLevel: "low",
		tools: ["read", "edit", "write", "grep", "find", "ls", "outline", "symbol", "references"],
	});
	const claimToken = randomUUID();
	recoverSupervisorRequests(controlDbPath);
	const abortController = new AbortController();
	const stop = () => abortController.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	while (!abortController.signal.aborted) {
		const request = claimNextSupervisorRequest(controlDbPath, claimToken);
		if (!request) {
			await waitForRequestPoll(abortController.signal);
			continue;
		}
		await processSupervisorRequest(controlDbPath, request, session);
	}
	await session.abort();
}

function openSupervisorSession(agentDir: string, kbDir: string): SessionManager {
	const sessionDir = join(agentDir, "supervisor-sessions");
	mkdirSync(sessionDir, { recursive: true });
	const existingSessionFile = readdirSync(sessionDir)
		.filter((file) => file.endsWith(`_${SUPERVISOR_SESSION_ID}.jsonl`))
		.sort()
		.at(-1);
	const sessionPath = existingSessionFile
		? join(sessionDir, existingSessionFile)
		: join(sessionDir, `${SUPERVISOR_SESSION_ID}.jsonl`);
	const sessionManager = existsSync(sessionPath)
		? SessionManager.open(sessionPath, sessionDir, kbDir)
		: SessionManager.create(kbDir, sessionDir, { id: SUPERVISOR_SESSION_ID });
	sessionManager.setMetadataControlDbPath(getControlDbPath(agentDir));
	const persistedPath = sessionManager.getSessionFile();
	if (persistedPath) archiveSession(getControlDbPath(agentDir), persistedPath);
	return sessionManager;
}

async function processSupervisorRequest(
	controlDbPath: string,
	request: SupervisorRequest,
	session: { abort(): Promise<void>; messages: unknown[]; prompt(content: string): Promise<void> },
): Promise<void> {
	try {
		await runSupervisorRequest({
			controlDbPath,
			evaluate: async (prompt, signal) => {
				const abort = () => void session.abort();
				signal.addEventListener("abort", abort, { once: true });
				try {
					await session.prompt(prompt);
					return readLastAssistantText(session.messages);
				} finally {
					signal.removeEventListener("abort", abort);
				}
			},
			request,
		});
	} catch (error) {
		completeSupervisorRequest(controlDbPath, request.id, requiredClaimToken(request), {
			kind: "error",
			reason: error instanceof Error ? error.message : String(error),
		});
	}
}

function readLastAssistantText(messages: unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		return message.content
			.filter(
				(part): part is { text: string; type: "text" } =>
					isRecord(part) && part.type === "text" && typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("");
	}
	throw new Error("Supervisor model returned no assistant text");
}

function readToolPath(input: unknown): string | undefined {
	return isRecord(input) && typeof input.path === "string" ? input.path : undefined;
}

function isPathWithinRoot(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

function requiredClaimToken(request: SupervisorRequest): string {
	if (!request.claimToken) throw new Error(`Supervisor request ${request.id} has no claim token`);
	return request.claimToken;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function waitForRequestPoll(signal: AbortSignal): Promise<void> {
	return new Promise((resolveWait) => {
		if (signal.aborted) {
			resolveWait();
			return;
		}
		const timer = setTimeout(done, REQUEST_POLL_INTERVAL_MS);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolveWait();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}
