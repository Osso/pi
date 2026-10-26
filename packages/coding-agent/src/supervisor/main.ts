import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
	type Api,
	type AssistantMessage,
	cleanupSessionResources,
	type Model,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { getAgentDir, VERSION } from "../config.ts";
import type { AgentSessionEvent } from "../core/agent-session.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import { CODEX_FALLBACK_PROVIDERS, isQuotaExhaustionError } from "../core/codex-quota-fallback.ts";
import type { LoadExtensionsResult } from "../core/extensions/types.ts";
import { ModelRegistry } from "../core/model-registry.ts";
import { mergeProviderAttributionHeaders } from "../core/provider-attribution.ts";
import { ResidentConsoleServer, type ResidentConsoleSnapshot } from "../core/resident-console-transport.ts";
import { prepareResidentSessionFile } from "../core/resident-session.ts";
import { DefaultResourceLoader } from "../core/resource-loader.ts";
import { createAgentSession } from "../core/sdk.ts";
import {
	archiveSession,
	claimNextSupervisorRequest,
	completeSupervisorRequest,
	getControlDbPath,
	readSupervisorRequest,
	recoverSupervisorRequests,
	type SupervisorRequest,
} from "../core/session-control-db.ts";
import { type SessionEntry, SessionManager } from "../core/session-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { resolveReadPath, resolveToCwd } from "../core/tools/path-utils.ts";
import { SUPERVISOR_AUTOSTART_ENV } from "./ensure-running.ts";
import { DEFAULT_SUPERVISOR_KB_DIR } from "./project-resolver.ts";
import { notifySupervisorRequest, SupervisorRequestWakeServer } from "./request-wake.ts";
import { createSupervisorResponseTool, SUPERVISOR_RESPONSE_TOOL_NAME } from "./response-tool.ts";
import {
	buildSupervisorInstructionReviewContext,
	parseSupervisorInstructionReviewDecision,
	parseSupervisorResponse,
	runSupervisorRequest,
	SUPERVISOR_INSTRUCTION_REJECTION_REASONS,
	type SupervisorInstructionRejectionReason,
	type SupervisorInstructionReviewDecision,
	supervisorInstructionRejectionFeedback,
} from "./service.ts";

const SUPERVISOR_SESSION_ID = "supervisor";
const SUPERVISOR_COMPACTION_PERCENT = 75;
const SUPERVISOR_INSTANCE_ID = randomUUID();

export const GENERIC_GOAL_CONTINUATION = "Continue working toward the active goal.";

export type SupervisorInstructionReviewer = (
	instructions: string,
	signal: AbortSignal,
) => Promise<SupervisorInstructionReviewDecision | undefined>;

interface SupervisorSession {
	abort(): Promise<void>;
	dispose(): void;
	compact?: (customInstructions?: string) => Promise<unknown>;
	getContextUsage?: () => { percent: number | null } | undefined;
	prompt(content: string): Promise<void>;
	sendCustomMessage?<T = unknown>(message: {
		customType: string;
		content: string;
		display: boolean;
		details?: T;
	}): Promise<void>;
	sessionId?: string;
	sessionManager: Pick<SessionManager, "getBranch" | "getLeafId">;
	subscribe?(listener: (event: AgentSessionEvent) => void): () => void;
}

export type SupervisorInstructionEvaluator = (instructions: string, signal: AbortSignal) => Promise<unknown>;

type SupervisorConsolePrompt = { id: string; text: string };

export class SupervisorConsolePromptQueue {
	private readonly prompts: SupervisorConsolePrompt[] = [];

	enqueue(text: string, id: string): void {
		this.prompts.push({ id, text });
	}

	take(): SupervisorConsolePrompt | undefined {
		return this.prompts.shift();
	}
}

interface RunSupervisorRequestLoopInput {
	claimNextRequest?: (controlDbPath: string, claimToken: string) => SupervisorRequest | undefined;
	claimToken: string;
	consolePrompts: SupervisorConsolePromptQueue;
	controlDbPath: string;
	processRequest?: (controlDbPath: string, request: SupervisorRequest, session: SupervisorSession) => Promise<void>;
	session: SupervisorSession;
	signal: AbortSignal;
	wakeServer: Pick<SupervisorRequestWakeServer, "currentGeneration" | "waitForWakeAfter">;
}

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

const SUPERVISOR_MODEL_ID = "gpt-6.1-sol";
const SUPERVISOR_PROVIDERS = ["openai-codex", ...(CODEX_FALLBACK_PROVIDERS.get("openai-codex") ?? [])];

function requireSupervisorModels(modelRegistry: ModelRegistry, agentDir: string): Model<Api>[] {
	const configured = SettingsManager.create(agentDir, agentDir).getSupervisorModel();
	if (configured) return [requireConfiguredSupervisorModel(modelRegistry, configured)];
	const models = SUPERVISOR_PROVIDERS.flatMap((provider) => {
		const model = modelRegistry.find(provider, SUPERVISOR_MODEL_ID);
		return model && modelRegistry.hasConfiguredAuth(model) ? [model] : [];
	});
	if (models.length === 0) {
		throw new Error(
			`Pi Supervisor requires ${SUPERVISOR_MODEL_ID} on an authenticated provider: ${SUPERVISOR_PROVIDERS.join(", ")}`,
		);
	}
	return models;
}

function requireConfiguredSupervisorModel(modelRegistry: ModelRegistry, configured: string): Model<Api> {
	const slash = configured.indexOf("/");
	const model = slash > 0 ? modelRegistry.find(configured.slice(0, slash), configured.slice(slash + 1)) : undefined;
	if (!model || !modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(`Pi Supervisor supervisorModel "${configured}" is not an authenticated provider/modelId`);
	}
	return model;
}

function readSupervisorInstructionReviewText(message: AssistantMessage): string | undefined {
	if (message.stopReason !== "stop") return undefined;
	const text = message.content
		.filter((part): part is { text: string; type: "text" } => part.type === "text")
		.map((part) => part.text)
		.join("");
	return text || undefined;
}

export function createSupervisorInstructionEvaluator(agentDir: string): SupervisorInstructionEvaluator {
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	const models = requireSupervisorModels(modelRegistry, agentDir);
	const settingsManager = createSupervisorSettingsManager();
	const evaluateWith = async (model: Model<Api>, instructions: string, signal: AbortSignal) => {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		const retrySettings = settingsManager.getProviderRetrySettings();
		const configuredIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
		const effectiveIdleTimeoutMs = configuredIdleTimeoutMs === 0 ? 2_147_483_647 : configuredIdleTimeoutMs;
		return streamSimple(model, buildSupervisorInstructionReviewContext(instructions, Date.now()), {
			apiKey: auth.apiKey,
			env: auth.env,
			headers: mergeProviderAttributionHeaders(model, settingsManager, undefined, auth.headers),
			maxRetries: retrySettings.maxRetries,
			maxRetryDelayMs: retrySettings.maxRetryDelayMs,
			reasoning: "low",
			signal,
			timeoutMs: retrySettings.timeoutMs ?? effectiveIdleTimeoutMs,
			websocketConnectTimeoutMs: settingsManager.getWebSocketConnectTimeoutMs(),
		}).result();
	};
	return async (instructions, signal) => {
		for (const model of models) {
			if (signal.aborted) return undefined;
			const response = await evaluateWith(model, instructions, signal);
			if (signal.aborted) return undefined;
			if (!isQuotaExhaustionError(response)) return readSupervisorInstructionReviewText(response);
		}
		return undefined;
	};
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

export function createSupervisorConsoleSnapshot(input: {
	cwd: string;
	generation: number;
	managedBy: "external" | "pi";
	session: Pick<SupervisorSession, "sessionId" | "sessionManager">;
}): ResidentConsoleSnapshot<SessionEntry> {
	return {
		service: "supervisor",
		sessionId: input.session.sessionId ?? SUPERVISOR_SESSION_ID,
		cwd: input.cwd,
		generation: input.generation,
		identity: {
			version: VERSION,
			pid: process.pid,
			executable: process.execPath,
			...(process.argv[1] ? { entrypoint: process.argv[1] } : {}),
			instanceId: SUPERVISOR_INSTANCE_ID,
			managedBy: input.managedBy,
			ready: true,
		},
		branch: input.session.sessionManager.getBranch(),
	};
}

export async function runSupervisorService(): Promise<void> {
	const agentDir = getAgentDir();
	const kbDir = process.env.PI_KB_DIR ?? DEFAULT_SUPERVISOR_KB_DIR;
	const controlDbPath = getControlDbPath();
	const sessionManager = openSupervisorSession(agentDir, kbDir);
	const session = await createSupervisorAgentSession(agentDir, kbDir, sessionManager);
	const reviewInstructions = createSupervisorInstructionReviewer(createSupervisorInstructionEvaluator(agentDir));
	const wakeServer = new SupervisorRequestWakeServer(controlDbPath);
	const consolePrompts = new SupervisorConsolePromptQueue();
	const managedBy = process.env[SUPERVISOR_AUTOSTART_ENV] === "1" ? "pi" : "external";
	const consoleServer = new ResidentConsoleServer<SessionEntry, AgentSessionEvent>({
		socketPath: `${controlDbPath}.supervisor-console.sock`,
		service: "supervisor",
		getSnapshot: () => createSupervisorConsoleSnapshot({ cwd: kbDir, generation: process.pid, managedBy, session }),
		enqueuePrompt: (text, id) => {
			consolePrompts.enqueue(text, id);
			notifySupervisorRequest(controlDbPath);
		},
		subscribe: (listener) => session.subscribe?.(listener) ?? (() => {}),
	});
	await wakeServer.start();
	await consoleServer.start();
	const abortController = new AbortController();
	const stop = () => abortController.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await runSupervisorRequestLoop({
			claimToken: randomUUID(),
			consolePrompts,
			controlDbPath,
			processRequest: (path, request, currentSession) =>
				processSupervisorRequest(path, request, currentSession, reviewInstructions),
			session,
			signal: abortController.signal,
			wakeServer,
		});
	} finally {
		abortController.abort();
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		await consoleServer.close();
		await wakeServer.close();
		await session.abort();
		// Releases provider connections, such as the cached Codex WebSocket, that otherwise keep the process alive.
		session.dispose();
	}
}

async function createSupervisorAgentSession(
	agentDir: string,
	kbDir: string,
	sessionManager: SessionManager,
): Promise<SupervisorSession> {
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	const [model] = requireSupervisorModels(modelRegistry, agentDir);
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
		customTools: [createSupervisorResponseTool()],
		tools: [...SUPERVISOR_TOOL_NAMES, SUPERVISOR_RESPONSE_TOOL_NAME],
	});
	return session;
}

export async function runSupervisorRequestLoop(input: RunSupervisorRequestLoopInput): Promise<void> {
	recoverSupervisorRequests(input.controlDbPath);
	const claimRequest = input.claimNextRequest ?? claimNextSupervisorRequest;
	const handleRequest = input.processRequest ?? processSupervisorRequest;
	while (!input.signal.aborted) {
		const observedGeneration = input.wakeServer.currentGeneration();
		const request = claimRequest(input.controlDbPath, input.claimToken);
		if (request) {
			await handleRequest(input.controlDbPath, request, input.session);
			continue;
		}
		const consolePrompt = input.consolePrompts.take();
		if (consolePrompt) {
			await input.session.prompt(consolePrompt.text);
			continue;
		}
		await input.wakeServer.waitForWakeAfter(observedGeneration, input.signal);
	}
}

export function openSupervisorSession(
	agentDir: string,
	kbDir: string,
	controlDbPath = getControlDbPath(),
): SessionManager {
	const { sessionDir, sessionPath } = prepareResidentSessionFile(agentDir, SUPERVISOR_SESSION_ID, controlDbPath);
	const sessionManager = existsSync(sessionPath)
		? SessionManager.open(sessionPath, sessionDir, kbDir)
		: SessionManager.create(kbDir, sessionDir, { id: SUPERVISOR_SESSION_ID });
	sessionManager.setMetadataControlDbPath(controlDbPath);
	const persistedPath = sessionManager.getSessionFile();
	if (persistedPath) archiveSession(controlDbPath, persistedPath);
	return sessionManager;
}

export function createSupervisorInstructionReviewer(
	evaluate: SupervisorInstructionEvaluator,
): SupervisorInstructionReviewer {
	return async (instructions, signal) => {
		if (signal.aborted) return undefined;
		return parseSupervisorInstructionReviewDecision(await evaluate(instructions, signal));
	};
}

function isInstructionRejectionReason(value: unknown): value is SupervisorInstructionRejectionReason {
	return SUPERVISOR_INSTRUCTION_REJECTION_REASONS.some((reason) => reason === value);
}

async function appendSupervisorPolicyFeedback<T>(
	session: SupervisorSession,
	content: string,
	details: T,
): Promise<void> {
	await session.sendCustomMessage?.({
		customType: "supervisor_policy_feedback",
		content,
		display: false,
		details,
	});
}

async function appendSupervisorInstructionReviewFailure(
	session: SupervisorSession,
	failure: "evaluation_error" | "invalid_response",
): Promise<void> {
	await appendSupervisorPolicyFeedback(
		session,
		`Policy gate failure: ${failure}. Non-generic instructions were suppressed.`,
		{ failure },
	);
}

async function applySupervisorInstructionVeto(
	request: SupervisorRequest,
	rawResponse: unknown,
	session: SupervisorSession,
	reviewInstructions: SupervisorInstructionReviewer,
	signal: AbortSignal,
): Promise<unknown> {
	if (request.kind !== "goal_idle_review" && request.kind !== "goal_completion_review") return rawResponse;
	const response = parseSupervisorResponse(request.kind, rawResponse);
	if (response?.kind !== "continue" || response.instructions === GENERIC_GOAL_CONTINUATION) return rawResponse;

	let decision: SupervisorInstructionReviewDecision | undefined;
	try {
		decision = await reviewInstructions(response.instructions, signal);
	} catch (error) {
		if (signal.aborted) throw error;
		await appendSupervisorInstructionReviewFailure(session, "evaluation_error");
		return { ...response, instructions: GENERIC_GOAL_CONTINUATION };
	}
	if (signal.aborted) throw new Error("Supervisor instruction review aborted");
	if (decision === "accept") return response;
	if (isInstructionRejectionReason(decision)) {
		await appendSupervisorPolicyFeedback(session, supervisorInstructionRejectionFeedback(decision), {
			reason: decision,
		});
	} else {
		await appendSupervisorInstructionReviewFailure(session, "invalid_response");
	}
	return { ...response, instructions: GENERIC_GOAL_CONTINUATION };
}

export async function processSupervisorRequest(
	controlDbPath: string,
	request: SupervisorRequest,
	session: SupervisorSession,
	reviewInstructions: SupervisorInstructionReviewer = async () => undefined,
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
					const contextPercent = session.getContextUsage?.()?.percent;
					if (
						session.compact &&
						contextPercent !== null &&
						contextPercent !== undefined &&
						contextPercent >= SUPERVISOR_COMPACTION_PERCENT
					) {
						await session.compact(
							"Preserve Supervisor decisions, project-specific policies, instruction-veto policy feedback, and reusable approval rationale.",
						);
						if (session.sessionId) cleanupSupervisorProviderContext(session.sessionId);
					}
					if (signal.aborted) throw new Error("Supervisor request aborted");
					const previousLeafId = session.sessionManager.getLeafId();
					await session.prompt(prompt);
					const rawResponse = readCurrentSupervisorResponse(session.sessionManager.getBranch(), previousLeafId);
					return applySupervisorInstructionVeto(request, rawResponse, session, reviewInstructions, signal);
				} finally {
					signal.removeEventListener("abort", abort);
				}
			},
			request,
		});
	} catch (error) {
		if (readSupervisorRequest(controlDbPath, request.id)?.status === "cancelled") return;
		try {
			completeSupervisorRequest(controlDbPath, request.id, requiredClaimToken(request), {
				kind: "error",
				reason: error instanceof Error ? error.message : String(error),
			});
		} catch (completionError) {
			if (readSupervisorRequest(controlDbPath, request.id)?.status === "cancelled") return;
			throw completionError;
		}
	}
}

export function cleanupSupervisorProviderContext(sessionId: string): void {
	cleanupSessionResources(sessionId);
}

function readCurrentSupervisorResponse(
	entries: ReturnType<SessionManager["getBranch"]>,
	previousLeafId: string | null,
): unknown {
	const previousLeafIndex = previousLeafId ? entries.findIndex((entry) => entry.id === previousLeafId) : -1;
	if (previousLeafId && previousLeafIndex === -1) {
		throw new Error("Supervisor request boundary is missing from the current session branch");
	}
	const currentMessages = entries
		.slice(previousLeafIndex + 1)
		.filter((entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message")
		.map((entry) => entry.message);
	const assistantMessages = currentMessages.filter(
		(message): message is AssistantMessage => message.role === "assistant",
	);
	const terminalMessage = assistantMessages.at(-1);
	if (!isRecord(terminalMessage) || !Array.isArray(terminalMessage.content)) {
		throw new Error("Supervisor model returned no assistant text for current request");
	}
	const structuredResponse = readStructuredSupervisorResponse(terminalMessage);
	if (structuredResponse !== undefined) return structuredResponse;
	const responseMessage = terminalMessageCallsEndTurn(terminalMessage)
		? [...assistantMessages].reverse().find((message) => message.stopReason === "stop")
		: terminalMessage;
	if (!isRecord(responseMessage) || !Array.isArray(responseMessage.content)) {
		throw new Error("Supervisor model returned no assistant text for current request");
	}
	if (responseMessage.stopReason !== "stop") {
		const detail = responseMessage.errorMessage ? `: ${responseMessage.errorMessage}` : "";
		throw new Error(`Supervisor model request ended with ${String(responseMessage.stopReason)}${detail}`);
	}
	const text = responseMessage.content
		.filter(
			(part): part is { text: string; type: "text" } =>
				isRecord(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("");
	if (!text.trim()) throw new Error("Supervisor model returned no assistant text for current request");
	return text;
}

function readStructuredSupervisorResponse(message: Record<string, unknown>): Record<string, unknown> | undefined {
	const content = message.content;
	if (!Array.isArray(content)) return undefined;
	const responseToolCall = content.find(
		(part) => isRecord(part) && part.type === "toolCall" && part.name === SUPERVISOR_RESPONSE_TOOL_NAME,
	);
	if (!isRecord(responseToolCall) || !isRecord(responseToolCall.arguments)) return undefined;
	const hasAssistantText = content.some(
		(part) => isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.trim(),
	);
	if (hasAssistantText) {
		throw new Error("Supervisor model emitted assistant text with structured response");
	}
	return responseToolCall.arguments;
}

function terminalMessageCallsEndTurn(message: Record<string, unknown>): boolean {
	return (
		message.stopReason === "toolUse" &&
		Array.isArray(message.content) &&
		message.content.some((part) => isRecord(part) && part.type === "toolCall" && part.name === "end_turn")
	);
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
