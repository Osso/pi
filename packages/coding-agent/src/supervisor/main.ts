import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import openAIRemoteCompactExtension from "../../extensions/openai-remote-compact/src/index.ts";
import { getAgentDir } from "../config.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import type { LoadExtensionsResult } from "../core/extensions/types.ts";
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
import { resolveReadPath, resolveToCwd } from "../core/tools/path-utils.ts";
import { DEFAULT_SUPERVISOR_KB_DIR } from "./project-resolver.ts";
import { runSupervisorRequest } from "./service.ts";

const SUPERVISOR_SESSION_ID = "supervisor";
const REQUEST_POLL_INTERVAL_MS = 100;
const SUPERVISOR_COMPACTION_PERCENT = 75;

export const SUPERVISOR_TOOL_NAMES = ["read", "edit", "write"];

export const SUPERVISOR_EXCLUDED_TOOL_NAMES = [
	"ask_architect",
	"attach_session_agent",
	"bash",
	"channel_post",
	"contact_parent",
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

export function validateSupervisorExtensionLoad(result: LoadExtensionsResult): void {
	if (result.errors.length === 0) return;
	const details = result.errors.map((error) => `${error.path}: ${error.error}`).join("; ");
	throw new Error(`Supervisor extension load failed: ${details}`);
}

export async function createSupervisorResourceLoader(
	agentDir: string,
	kbDir: string,
	settingsManager: SettingsManager,
): Promise<DefaultResourceLoader> {
	const resourceLoader = new DefaultResourceLoader({
		agentDir,
		cwd: kbDir,
		extensionFactories: [
			(pi) => {
				pi.registerToolGate((event) => blockSupervisorFileAccess(kbDir, event));
			},
			openAIRemoteCompactExtension,
		],
		noContextFiles: true,
		noExtensions: true,
		noPromptTemplates: true,
		noSkills: true,
		noThemes: true,
		settingsManager,
	});
	await resourceLoader.reload();
	validateSupervisorExtensionLoad(resourceLoader.getExtensions());
	return resourceLoader;
}

export function blockSupervisorFileAccess(
	kbDir: string,
	event: { input: unknown; toolName: string },
): { block: true; reason: string } | undefined {
	if (!SUPERVISOR_TOOL_NAMES.includes(event.toolName)) return undefined;
	const path = readToolPath(event.input);
	if (!path) return supervisorFileAccessBlock();
	try {
		const resolvedPath = event.toolName === "read" ? resolveReadPath(path, kbDir) : resolveToCwd(path, kbDir);
		if (isPathWithinRoot(resolveExistingPath(resolvedPath), resolveExistingPath(kbDir))) return undefined;
	} catch {}
	return supervisorFileAccessBlock();
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
	const resourceLoader = await createSupervisorResourceLoader(agentDir, kbDir, settingsManager);
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
		tools: SUPERVISOR_TOOL_NAMES,
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

export async function processSupervisorRequest(
	controlDbPath: string,
	request: SupervisorRequest,
	session: {
		abort(): Promise<void>;
		compact?: (customInstructions?: string) => Promise<unknown>;
		getContextUsage?: () => { percent: number | null } | undefined;
		prompt(content: string): Promise<void>;
		sessionManager: Pick<SessionManager, "getBranch" | "getLeafId">;
	},
): Promise<void> {
	try {
		await runSupervisorRequest({
			controlDbPath,
			evaluate: async (prompt, signal) => {
				const abort = () => void session.abort();
				signal.addEventListener("abort", abort, { once: true });
				try {
					if (signal.aborted) {
						await session.abort();
						throw new Error("Supervisor request aborted");
					}
					const contextPercent = session.getContextUsage?.().percent;
					if (
						session.compact &&
						contextPercent !== null &&
						contextPercent !== undefined &&
						contextPercent >= SUPERVISOR_COMPACTION_PERCENT
					) {
						await session.compact(
							"Preserve Supervisor decisions, project-specific policies, and reusable approval rationale.",
						);
					}
					if (signal.aborted) throw new Error("Supervisor request aborted");
					const previousLeafId = session.sessionManager.getLeafId();
					await session.prompt(prompt);
					return readCurrentAssistantText(session.sessionManager.getBranch(), previousLeafId);
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

function readCurrentAssistantText(
	entries: ReturnType<SessionManager["getBranch"]>,
	previousLeafId: string | null,
): string {
	const previousLeafIndex = previousLeafId ? entries.findIndex((entry) => entry.id === previousLeafId) : -1;
	if (previousLeafId && previousLeafIndex === -1) {
		throw new Error("Supervisor request boundary is missing from the current session branch");
	}
	const terminalAssistant = entries
		.slice(previousLeafIndex + 1)
		.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
		.at(-1);
	const terminalMessage = terminalAssistant?.type === "message" ? terminalAssistant.message : undefined;
	if (!isRecord(terminalMessage) || !Array.isArray(terminalMessage.content)) {
		throw new Error("Supervisor model returned no assistant text for current request");
	}
	if (terminalMessage.stopReason !== "stop") {
		throw new Error(`Supervisor model request ended with ${String(terminalMessage.stopReason)}`);
	}
	const text = terminalMessage.content
		.filter(
			(part): part is { text: string; type: "text" } =>
				isRecord(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("");
	if (!text.trim()) throw new Error("Supervisor model returned no assistant text for current request");
	return text;
}

function readToolPath(input: unknown): string | undefined {
	return isRecord(input) && typeof input.path === "string" ? input.path : undefined;
}

function supervisorFileAccessBlock(): { block: true; reason: string } {
	return { block: true, reason: "Pi Supervisor may access files only inside the configured KB directory." };
}

function resolveExistingPath(path: string): string {
	const suffix: string[] = [];
	let existingPath = resolve(path);
	while (!existsSync(existingPath)) {
		const parent = dirname(existingPath);
		if (parent === existingPath) return resolve(path);
		suffix.unshift(basename(existingPath));
		existingPath = parent;
	}
	return resolve(realpathSync(existingPath), ...suffix);
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
