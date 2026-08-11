import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai/compat";
import type { AgentMailboxMessage, AgentSnapshot } from "../../src/core/multi-agent-store.ts";
import { MultiAgentStore } from "../../src/core/multi-agent-store.ts";
import {
	type ApprovalPresetName,
	findApprovalPreset,
	type SandboxProfileName,
} from "../../src/core/permissions/presets.ts";
import {
	claimNextSupervisorRequest,
	completeSupervisorRequest,
	getControlDbPath,
	listRuntimeMailboxMessages,
	type RuntimeMailboxMessage,
	readMultiAgentRuntimeOwnership,
	readSessionGoal,
	readSessionMetadata,
	type SupervisorRequest,
	type SupervisorRequestKind,
	type SupervisorResponse,
	writeSessionGoal,
} from "../../src/core/session-control-db.ts";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { isProcessIdentityAlive, type ProcessIdentity } from "../../src/core/runtime-process.ts";
import { createSqliteDatabase } from "../../src/core/sqlite.ts";
import { RpcClient, type RpcCommandBody } from "../../src/modes/rpc/rpc-client.ts";
import type { RpcExtensionUIRequest, RpcResponse } from "../../src/modes/rpc/rpc-types.ts";

const DEFAULT_TIMEOUT_MS = 10_000;

interface WireLlmRequest {
	type: "request";
	id: string;
	sessionId?: string;
	systemPrompt?: string;
	messages: Message[];
}

export interface HeadlessLlmRequest {
	id: string;
	sessionId?: string;
	agentId: string | null;
	systemPrompt?: string;
	messages: Message[];
	userMessages: string[];
}

export interface HeadlessPiPaths {
	tempDir: string;
	agentDir: string;
	sessionDir: string;
	workspaceDir: string;
}

interface HeadlessRuntimePaths extends HeadlessPiPaths {
	socketPath: string;
}

export interface HeadlessPiOptions {
	approvalPreset?: ApprovalPresetName;
	autoDetachTools?: boolean;
	deleteCwdBeforeSelfRestart?: boolean;
	env?: Record<string, string>;
	model?: string | false;
	provider?: "headless-faux" | "openai-codex";
	sandboxProfile?: SandboxProfileName;
}

export interface HeadlessRpcExtensionError {
	type: "extension_error";
	extensionPath: string;
	event: string;
	error: string;
}

export interface HeadlessSharedSession {
	sessionId: string;
	sessionFile: string;
	dispose(): Promise<void>;
}

export interface HeadlessSharedSessionOptions {
	sessionFile?: string;
	sessionStartReleasePath?: string;
}

export interface HeadlessPi {
	paths: HeadlessPiPaths;
	sessionId: string;
	sessionFile: string;
	crash(): Promise<void>;
	restart(): Promise<void>;
	startSharedSession(options?: HeadlessSharedSessionOptions): Promise<HeadlessSharedSession>;
	send(command: RpcCommandBody): Promise<RpcResponse>;
	getPyrunRunnerPids(): number[];
	getRunnerPid(agentId: string): number | undefined;
	listAgents(): AgentSnapshot[];
	listMailboxMessages(): AgentMailboxMessage[];
	listRuntimeMailboxMessages(): RuntimeMailboxMessage[];
	readSessionEntries(agentId: string | null): SessionEntry[];
	readSessionMetadata(agentId: string | null): {
		modelProvider?: string;
		modelId?: string;
		thinkingLevel?: string;
	};
	readTerminalOutboxStatuses(agentId: string): string[];
	writeRunningGoal(objective: string): void;
	readGoal(): Record<string, unknown> | undefined;
	countSupervisorRequests(kind: SupervisorRequestKind): number;
	countExtensionUiRequests(predicate?: (request: RpcExtensionUIRequest) => boolean): number;
	waitForSessionEntry(agentId: string | null, predicate: (entry: SessionEntry) => boolean): Promise<SessionEntry>;
	waitForEvent(predicate: (event: AgentEvent) => boolean): Promise<AgentEvent>;
	waitForExtensionError(predicate?: (error: HeadlessRpcExtensionError) => boolean): Promise<HeadlessRpcExtensionError>;
	waitForExtensionUiRequest(predicate?: (request: RpcExtensionUIRequest) => boolean): Promise<RpcExtensionUIRequest>;
	waitForLlmRequest(
		predicate?: (request: HeadlessLlmRequest) => boolean,
		timeoutMs?: number,
	): Promise<HeadlessLlmRequest>;
	waitForSupervisorRequest(kind: SupervisorRequestKind): Promise<SupervisorRequest>;
	respondToSupervisorRequest(request: SupervisorRequest, response: SupervisorResponse): void;
	respondToLlmRequest(requestId: string, message: AssistantMessage): void;
	waitForAgent(predicate: (agent: AgentSnapshot) => boolean): Promise<AgentSnapshot>;
	waitForMailboxMessage(predicate: (message: AgentMailboxMessage) => boolean): Promise<AgentMailboxMessage>;
}

interface HeadlessPiRuntime extends HeadlessPi {
	dispose(): Promise<void>;
}

function createHeadlessModelConfig(id: string, name: string, reasoning = false) {
	return {
		id,
		name,
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

function createModelsJson(provider: HeadlessPiOptions["provider"] = "headless-faux"): string {
	const codexProvider =
		provider === "openai-codex"
			? {
					"openai-codex": {
						api: "headless-faux",
						apiKey: "test-key",
						baseUrl: "http://localhost:0",
						models: [createHeadlessModelConfig("headless-faux-codex", "Headless Faux Codex")],
					},
				}
			: {};
	return JSON.stringify({
		providers: {
			"headless-faux": {
				api: "headless-faux",
				apiKey: "test-key",
				baseUrl: "http://localhost:0",
				models: [
					createHeadlessModelConfig("headless-faux-1", "Headless Faux"),
					createHeadlessModelConfig("headless-faux-reasoning", "Headless Faux Reasoning", true),
				],
			},
			...codexProvider,
		},
	});
}

interface HeadlessPathOperations {
	createTempDir: () => string;
	createDirectory: (path: string) => void;
	writeModelsJson: (path: string, content: string) => void;
	removeTempDir: (path: string) => void;
}

const defaultHeadlessPathOperations: HeadlessPathOperations = {
	createTempDir: () => mkdtempSync(join(tmpdir(), "pi-headless-")),
	createDirectory: (path) => mkdirSync(path, { recursive: true }),
	writeModelsJson: (path, content) => writeFileSync(path, content),
	removeTempDir: (path) => rmSync(path, { recursive: true, force: true }),
};

export function createHeadlessPaths(
	operations: HeadlessPathOperations = defaultHeadlessPathOperations,
	provider: HeadlessPiOptions["provider"] = "headless-faux",
): HeadlessRuntimePaths {
	const tempDir = operations.createTempDir();
	const paths = {
		tempDir,
		agentDir: join(tempDir, "agent"),
		sessionDir: join(tempDir, "sessions"),
		workspaceDir: join(tempDir, "workspace"),
		socketPath: join(tempDir, "provider.sock"),
	};
	try {
		operations.createDirectory(paths.agentDir);
		operations.createDirectory(paths.sessionDir);
		operations.createDirectory(paths.workspaceDir);
		operations.writeModelsJson(join(paths.agentDir, "models.json"), createModelsJson(provider));
		return paths;
	} catch (error) {
		try {
			operations.removeTempDir(tempDir);
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Headless Pi path setup and cleanup failed");
		}
		throw error;
	}
}

function userMessageText(message: Message): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function waitForServer(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

interface ProviderServerControl {
	server: Server;
	getSocket: () => Socket | undefined;
}

function throwUnexpectedProviderSocketError(error: Error): void {
	if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") throw error;
}

export async function createProviderServer(
	socketPath: string,
	recordRequest: (request: WireLlmRequest) => void,
): Promise<ProviderServerControl> {
	let providerSocket: Socket | undefined;
	let inputBuffer = "";
	const server = createServer((socket) => {
		providerSocket = socket;
		socket.on("error", throwUnexpectedProviderSocketError);
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			inputBuffer += chunk;
			while (true) {
				const newlineIndex = inputBuffer.indexOf("\n");
				if (newlineIndex === -1) return;
				const line = inputBuffer.slice(0, newlineIndex);
				inputBuffer = inputBuffer.slice(newlineIndex + 1);
				if (line) recordRequest(JSON.parse(line) as WireLlmRequest);
			}
		});
	});
	await waitForServer(server, socketPath);
	return { server, getSocket: () => providerSocket };
}

function createHeadlessRpcClient(
	paths: HeadlessRuntimePaths,
	options: HeadlessPiOptions,
	sessionFile?: string,
	providerSocketPath = paths.socketPath,
	sessionStartReleasePath?: string,
): RpcClient {
	const preloadPath = join(import.meta.dirname, "fixtures", "headless-pi-provider-preload.ts");
	const deleteCwdPreloadPath = join(import.meta.dirname, "fixtures", "delete-cwd-self-restart-preload.mjs");
	const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
	const args = [...(options.approvalPreset ? [] : ["--approve"]), "--no-context-files", "--no-skills", "--no-themes"];
	if (sessionFile) args.push("--session", sessionFile);
	const selectedProvider = options.provider ?? "headless-faux";
	const defaultModel = selectedProvider === "openai-codex" ? "headless-faux-codex" : "headless-faux-1";
	return new RpcClient({
		cliPath,
		cwd: paths.workspaceDir,
		env: {
			PI_CODING_AGENT_DIR: paths.agentDir,
			PI_CODING_AGENT_STATE_DIR: paths.agentDir,
			PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
			PI_HEADLESS_PROVIDER_SOCKET: providerSocketPath,
			...(options.autoDetachTools ? { PI_HEADLESS_TOOL_AUTO_DETACH_MS: "50" } : {}),
			...(options.env ?? {}),
			...(sessionStartReleasePath ? { PI_HEADLESS_SESSION_START_RELEASE_PATH: sessionStartReleasePath } : {}),
		},
		provider: selectedProvider,
		model: options.model === false ? undefined : (options.model ?? defaultModel),
		nodeArgs: [
			"--import",
			import.meta.resolve("tsx"),
			"--import",
			pathToFileURL(preloadPath).href,
			...(options.deleteCwdBeforeSelfRestart ? ["--import", pathToFileURL(deleteCwdPreloadPath).href] : []),
		],
		args,
	});
}

interface HeadlessPiCleanupOperations {
	stopClient: () => Promise<void>;
	terminateDetachedRunners?: () => void | Promise<void>;
	destroyProviderSocket: () => void;
	closeProviderServer: () => Promise<void>;
	removeTempDir: () => void;
}

export async function cleanupHeadlessRuntimeResources(
	sharedSessionCleanup: Array<() => Promise<void>>,
	cleanupPrimary: () => Promise<void>,
): Promise<void> {
	const errors: unknown[] = [];
	const sharedResults = await Promise.allSettled(sharedSessionCleanup.map((cleanup) => cleanup()));
	for (const result of sharedResults) {
		if (result.status === "rejected") errors.push(result.reason);
	}
	try {
		await cleanupPrimary();
	} catch (error) {
		errors.push(error);
	}
	if (errors.length > 0) throw new AggregateError(errors, "Headless Pi runtime cleanup failed");
}

export async function cleanupHeadlessPiResources(operations: HeadlessPiCleanupOperations): Promise<void> {
	const errors: unknown[] = [];
	for (const cleanup of [
		operations.stopClient,
		async () => {
			await operations.terminateDetachedRunners?.();
		},
		async () => operations.destroyProviderSocket(),
		operations.closeProviderServer,
		async () => operations.removeTempDir(),
	]) {
		try {
			await cleanup();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "Headless Pi cleanup failed");
}

export async function runWithCleanup<T>(run: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
	let result: T | undefined;
	let runFailed = false;
	let runError: unknown;
	try {
		result = await run();
	} catch (error) {
		runFailed = true;
		runError = error;
	}

	let cleanupFailed = false;
	let cleanupError: unknown;
	try {
		await cleanup();
	} catch (error) {
		cleanupFailed = true;
		cleanupError = error;
	}

	if (runFailed && cleanupFailed) {
		throw new AggregateError([runError, cleanupError], "Headless Pi scenario and cleanup failed");
	}
	if (runFailed) throw runError;
	if (cleanupFailed) throw cleanupError;
	return result as T;
}

function waitForBufferedItem<T>(options: {
	items: T[];
	listeners: Set<() => void>;
	predicate: (item: T) => boolean;
	disposeSignal: AbortSignal;
	timeoutError: () => Error;
	timeoutMs?: number;
}): Promise<T> {
	if (options.disposeSignal.aborted) return Promise.reject(new Error("Headless Pi fixture disposed"));
	return new Promise((resolve, reject) => {
		const findItem = (): T | undefined => {
			const index = options.items.findIndex(options.predicate);
			if (index === -1) return undefined;
			return options.items.splice(index, 1)[0];
		};
		const cleanup = (): void => {
			clearTimeout(timeout);
			options.listeners.delete(check);
			options.disposeSignal.removeEventListener("abort", abort);
		};
		const abort = (): void => {
			cleanup();
			reject(new Error("Headless Pi fixture disposed"));
		};
		const check = (): void => {
			const item = findItem();
			if (!item) return;
			cleanup();
			resolve(item);
		};
		const existing = findItem();
		if (existing) {
			resolve(existing);
			return;
		}
		const timeout = setTimeout(() => {
			cleanup();
			reject(options.timeoutError());
		}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		options.listeners.add(check);
		options.disposeSignal.addEventListener("abort", abort, { once: true });
	});
}

function readHeadlessStore(agentDir: string, sessionFile: string): MultiAgentStore {
	const sessionManager = SessionManager.open(sessionFile);
	sessionManager.setMetadataControlDbPath(getControlDbPath(agentDir));
	return MultiAgentStore.fromSessionManager(sessionManager);
}

function createStorePoller(options: {
	agentDir: string;
	getSessionFile: () => string;
	disposeSignal: AbortSignal;
	getStderr: () => string;
}) {
	return async <T>(read: (store: MultiAgentStore) => T | undefined, description: string): Promise<T> => {
		const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (options.disposeSignal.aborted) throw new Error("Headless Pi fixture disposed");
			const store = readHeadlessStore(options.agentDir, options.getSessionFile());
			const value = read(store);
			if (value !== undefined) return value;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`Timed out waiting for ${description}. Stderr: ${options.getStderr()}`);
	};
}

interface DetachedPayloadIdentity extends ProcessIdentity {
	pgid: number;
}

interface CapturedDetachedIdentities {
	runners: ProcessIdentity[];
	payloads: DetachedPayloadIdentity[];
}

function parseProcessIdentity(value: unknown): ProcessIdentity | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const pid = record.pid;
	const startTimeTicks = record.startTimeTicks;
	if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(startTimeTicks) || startTimeTicks <= 0) {
		return undefined;
	}
	return { pid, startTimeTicks };
}

function parseDetachedPayloadIdentity(value: unknown): DetachedPayloadIdentity | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const identity = parseProcessIdentity(value);
	const pgid = (value as Record<string, unknown>).pgid;
	if (!identity || !Number.isSafeInteger(pgid) || pgid <= 0) return undefined;
	return { ...identity, pgid };
}

function identityKey(identity: ProcessIdentity): string {
	return `${identity.pid}:${identity.startTimeTicks}`;
}

function readHeadlessDetachedIdentityFile(path: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
	} catch {
		// Partial launch manifests and identity files have no reliable process identity to terminate.
		return undefined;
	}
}

function collectHeadlessDetachedIdentityFiles(
	root: string,
	addRunner: (identity: ProcessIdentity | undefined) => void,
	addPayload: (identity: DetachedPayloadIdentity | undefined) => void,
): void {
	for (const relativePath of readdirSync(root, { recursive: true })) {
		if (typeof relativePath !== "string") continue;
		const isLaunchManifest = relativePath.endsWith("launch.json");
		const isPayloadIdentity = relativePath.endsWith("payload.json");
		if (!isLaunchManifest && !isPayloadIdentity) continue;
		const data = readHeadlessDetachedIdentityFile(join(root, relativePath));
		if (!data) continue;
		if (isLaunchManifest) addRunner(parseProcessIdentity(data.runnerProcessIdentity));
		else addPayload(parseDetachedPayloadIdentity(data));
	}
}

function collectHeadlessDetachedIdentities(
	paths: HeadlessRuntimePaths,
	sessionFile: string,
): CapturedDetachedIdentities {
	const runners = new Map<string, ProcessIdentity>();
	const payloads = new Map<string, DetachedPayloadIdentity>();
	const addRunner = (identity: ProcessIdentity | undefined): void => {
		if (identity) runners.set(identityKey(identity), identity);
	};
	const addPayload = (identity: DetachedPayloadIdentity | undefined): void => {
		if (identity) payloads.set(identityKey(identity), identity);
	};
	for (const agent of readHeadlessStore(paths.agentDir, sessionFile).listAgents()) {
		const ownership = readMultiAgentRuntimeOwnership(getControlDbPath(paths.agentDir), sessionFile, agent.id);
		addRunner(parseProcessIdentity(ownership?.processIdentity));
	}
	collectHeadlessDetachedIdentityFiles(paths.agentDir, addRunner, addPayload);
	collectHeadlessDetachedIdentityFiles(paths.sessionDir, addRunner, addPayload);
	return { runners: [...runners.values()], payloads: [...payloads.values()] };
}

function killHeadlessProcessGroup(identity: ProcessIdentity, pgid: number): void {
	if (!isProcessIdentityAlive(identity)) return;
	try {
		process.kill(-pgid, "SIGKILL");
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	try {
		process.kill(identity.pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

async function waitForHeadlessProcessExit(identities: ProcessIdentity[]): Promise<void> {
	const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
	while (identities.some((identity) => isProcessIdentityAlive(identity))) {
		if (Date.now() >= deadline) {
			const active = identities.filter((identity) => isProcessIdentityAlive(identity));
			throw new Error(`Timed out waiting for detached processes: ${active.map(identityKey).join(", ")}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function terminateHeadlessDetachedRunners(paths: HeadlessRuntimePaths, sessionFile: string): Promise<void> {
	const captured = collectHeadlessDetachedIdentities(paths, sessionFile);
	for (const payload of captured.payloads) killHeadlessProcessGroup(payload, payload.pgid);
	for (const runner of captured.runners) killHeadlessProcessGroup(runner, runner.pid);
	await waitForHeadlessProcessExit([
		...captured.runners,
		...captured.payloads,
	]);
}

function cleanupHeadlessStartup(
	paths: HeadlessRuntimePaths,
	client: RpcClient | undefined,
	provider: ProviderServerControl | undefined,
): Promise<void> {
	return cleanupHeadlessPiResources({
		stopClient: () => client?.stop() ?? Promise.resolve(),
		destroyProviderSocket: () => provider?.getSocket()?.destroy(),
		closeProviderServer: () => (provider ? closeServer(provider.server) : Promise.resolve()),
		removeTempDir: () => rmSync(paths.tempDir, { recursive: true, force: true }),
	});
}

interface HeadlessSessionContext {
	mainSessionId: string;
	sessionFile: string;
}

function createRequestRecorder(options: {
	requests: HeadlessLlmRequest[];
	listeners: Set<() => void>;
	resolveAgentId: (sessionId: string | undefined) => string | null;
}): (wireRequest: WireLlmRequest) => void {
	return (wireRequest) => {
		options.requests.push({
			id: wireRequest.id,
			sessionId: wireRequest.sessionId,
			agentId: options.resolveAgentId(wireRequest.sessionId),
			systemPrompt: wireRequest.systemPrompt,
			messages: wireRequest.messages,
			userMessages: wireRequest.messages.map(userMessageText).filter((text): text is string => text !== undefined),
		});
		for (const listener of options.listeners) listener();
	};
}

async function startRpcClientSession(client: RpcClient, context: HeadlessSessionContext): Promise<void> {
	await client.start();
	const state = await client.getState();
	context.mainSessionId = state.sessionId;
	context.sessionFile = state.sessionFile ?? "";
	if (!context.sessionFile) throw new Error("Headless Pi did not create a persistent session");
}

interface RpcClientProcess {
	exitCode: number | null;
	kill(signal: NodeJS.Signals): boolean;
	once(event: "exit", listener: () => void): unknown;
}

interface RpcClientInternals {
	process: RpcClientProcess | null;
}

interface HeadlessClientControl {
	client: RpcClient;
	unsubscribeEvents: () => void;
}

function resolveHeadlessSessionFile(
	options: { paths: HeadlessRuntimePaths; context: HeadlessSessionContext },
	agentId: string | null,
): string {
	if (agentId === null) return options.context.sessionFile;
	const agent = readHeadlessStore(options.paths.agentDir, options.context.sessionFile).getAgent(agentId);
	if (!agent?.transcript?.path) throw new Error(`Headless agent ${agentId} has no transcript path`);
	return agent.transcript.path;
}

function subscribeHeadlessRpcOutput(
	client: RpcClient,
	options: {
		events: AgentEvent[];
		eventListeners: Set<() => void>;
		extensionErrors: HeadlessRpcExtensionError[];
		extensionErrorListeners: Set<() => void>;
		uiRequests: RpcExtensionUIRequest[];
		uiRequestListeners: Set<() => void>;
	},
): () => void {
	return client.onEvent((event) => {
		const output: unknown = event;
		if (isExtensionUiRequest(output)) {
			options.uiRequests.push(output);
			for (const listener of options.uiRequestListeners) listener();
			return;
		}
		if (isExtensionError(output)) {
			options.extensionErrors.push(output);
			for (const listener of options.extensionErrorListeners) listener();
			return;
		}
		options.events.push(event);
		for (const listener of options.eventListeners) listener();
	});
}

function isExtensionError(value: unknown): value is HeadlessRpcExtensionError {
	return (
		isRecord(value) &&
		value.type === "extension_error" &&
		typeof value.extensionPath === "string" &&
		typeof value.event === "string" &&
		typeof value.error === "string"
	);
}

function isExtensionUiRequest(value: unknown): value is RpcExtensionUIRequest {
	return isRecord(value) && value.type === "extension_ui_request" && typeof value.id === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function startSharedHeadlessSession(
	paths: HeadlessRuntimePaths,
	fixtureOptions: HeadlessPiOptions,
	sharedSessions: Set<HeadlessSharedSession>,
	options: HeadlessSharedSessionOptions = {},
): Promise<HeadlessSharedSession> {
	const socketPath = join(paths.tempDir, `provider-${randomUUID()}.sock`);
	const context: HeadlessSessionContext = { mainSessionId: "", sessionFile: "" };
	const provider = await createProviderServer(socketPath, () => {});
	const client = createHeadlessRpcClient(
		paths,
		fixtureOptions,
		options.sessionFile,
		socketPath,
		options.sessionStartReleasePath,
	);
	const unsubscribeEvents = subscribeHeadlessRpcOutput(client, {
		events: [],
		eventListeners: new Set(),
		uiRequests: [],
		uiRequestListeners: new Set(),
		extensionErrors: [],
		extensionErrorListeners: new Set(),
	});
	const cleanup = () =>
		cleanupHeadlessPiResources({
			stopClient: () => client.stop(),
			destroyProviderSocket: () => provider.getSocket()?.destroy(),
			closeProviderServer: () => closeServer(provider.server),
			removeTempDir: () => {},
		});
	try {
		await startRpcClientSession(client, context);
	} catch (error) {
		unsubscribeEvents();
		return runWithCleanup(async () => {
			throw error;
		}, cleanup);
	}
	let disposed = false;
	const shared: HeadlessSharedSession = {
		sessionId: context.mainSessionId,
		sessionFile: context.sessionFile,
		async dispose() {
			if (disposed) return;
			unsubscribeEvents();
			await cleanup();
			disposed = true;
			sharedSessions.delete(shared);
		},
	};
	sharedSessions.add(shared);
	return shared;
}

function createHeadlessRuntime(options: {
	paths: HeadlessRuntimePaths;
	fixtureOptions: HeadlessPiOptions;
	clientControl: HeadlessClientControl;
	provider: ProviderServerControl;
	disposeController: AbortController;
	events: AgentEvent[];
	eventListeners: Set<() => void>;
	extensionErrors: HeadlessRpcExtensionError[];
	extensionErrorListeners: Set<() => void>;
	uiRequests: RpcExtensionUIRequest[];
	uiRequestListeners: Set<() => void>;
	requests: HeadlessLlmRequest[];
	requestListeners: Set<() => void>;
	context: HeadlessSessionContext;
}): HeadlessPiRuntime {
	const waitForEvent = (predicate: (event: AgentEvent) => boolean): Promise<AgentEvent> =>
		waitForBufferedItem({
			items: options.events,
			listeners: options.eventListeners,
			predicate,
			disposeSignal: options.disposeController.signal,
			timeoutError: () =>
				new Error(`Timed out waiting for RPC event. Stderr: ${options.clientControl.client.getStderr()}`),
		});
	const waitForExtensionError = (
		predicate: (error: HeadlessRpcExtensionError) => boolean,
	): Promise<HeadlessRpcExtensionError> =>
		waitForBufferedItem({
			items: options.extensionErrors,
			listeners: options.extensionErrorListeners,
			predicate,
			disposeSignal: options.disposeController.signal,
			timeoutError: () =>
				new Error(`Timed out waiting for RPC extension error. Stderr: ${options.clientControl.client.getStderr()}`),
		});
	const waitForRequest = (
		predicate: (request: HeadlessLlmRequest) => boolean,
		timeoutMs?: number,
	): Promise<HeadlessLlmRequest> =>
		waitForBufferedItem({
			items: options.requests,
			listeners: options.requestListeners,
			predicate,
			disposeSignal: options.disposeController.signal,
			timeoutError: () =>
				new Error(`Timed out waiting for LLM request. Stderr: ${options.clientControl.client.getStderr()}`),
			timeoutMs,
		});
	const waitForUiRequest = (predicate: (request: RpcExtensionUIRequest) => boolean): Promise<RpcExtensionUIRequest> =>
		waitForBufferedItem({
			items: options.uiRequests,
			listeners: options.uiRequestListeners,
			predicate,
			disposeSignal: options.disposeController.signal,
			timeoutError: () =>
				new Error(
					`Timed out waiting for extension UI request. Stderr: ${options.clientControl.client.getStderr()}`,
				),
		});
	const pollStore = createStorePoller({
		agentDir: options.paths.agentDir,
		getSessionFile: () => options.context.sessionFile,
		disposeSignal: options.disposeController.signal,
		getStderr: () => options.clientControl.client.getStderr(),
	});
	const sharedSessions = new Set<HeadlessSharedSession>();

	return {
		paths: {
			tempDir: options.paths.tempDir,
			agentDir: options.paths.agentDir,
			sessionDir: options.paths.sessionDir,
			workspaceDir: options.paths.workspaceDir,
		},
		sessionId: options.context.mainSessionId,
		sessionFile: options.context.sessionFile,
		async restart() {
			options.clientControl.unsubscribeEvents();
			await options.clientControl.client.stop();
			options.events.length = 0;
			options.extensionErrors.length = 0;
			options.uiRequests.length = 0;
			options.requests.length = 0;
			const client = createHeadlessRpcClient(options.paths, options.fixtureOptions, options.context.sessionFile);
			options.clientControl.client = client;
			options.clientControl.unsubscribeEvents = subscribeHeadlessRpcOutput(client, options);
			await startRpcClientSession(client, options.context);
		},
		async crash() {
			options.clientControl.unsubscribeEvents();
			const process = (options.clientControl.client as unknown as RpcClientInternals).process;
			if (!process) throw new Error("Headless Pi RPC process is not running");
			const exited =
				process.exitCode === null
					? new Promise<void>((resolve) => {
							process.once("exit", resolve);
						})
					: Promise.resolve();
			process.kill("SIGKILL");
			await exited;
			await options.clientControl.client.stop();
		},
		startSharedSession: (sharedOptions) =>
			startSharedHeadlessSession(options.paths, options.fixtureOptions, sharedSessions, sharedOptions),
		send: (command) => options.clientControl.client.send(command),
		getPyrunRunnerPids: () =>
			readdirSync(options.paths.sessionDir, { recursive: true })
				.filter((path): path is string => typeof path === "string" && path.endsWith("launch.json"))
				.map(
					(path) =>
						JSON.parse(readFileSync(join(options.paths.sessionDir, path), "utf8")) as Record<string, unknown>,
				)
				.map((manifest) => (manifest.runnerProcessIdentity as { pid?: number } | undefined)?.pid)
				.filter((pid): pid is number => typeof pid === "number"),
		getRunnerPid: (agentId) =>
			readMultiAgentRuntimeOwnership(getControlDbPath(options.paths.agentDir), options.context.sessionFile, agentId)
				?.processIdentity?.pid,
		listAgents: () => readHeadlessStore(options.paths.agentDir, options.context.sessionFile).listAgents(),
		listMailboxMessages: () =>
			readHeadlessStore(options.paths.agentDir, options.context.sessionFile).listMailboxMessages(),
		listRuntimeMailboxMessages: () => listRuntimeMailboxMessages(getControlDbPath(options.paths.agentDir)),
		readSessionEntries: (agentId) => SessionManager.open(resolveHeadlessSessionFile(options, agentId)).getEntries(),
		readSessionMetadata: (agentId) => {
			const metadata = readSessionMetadata(
				getControlDbPath(options.paths.agentDir),
				resolveHeadlessSessionFile(options, agentId),
			);
			if (!metadata) throw new Error(`No metadata for headless agent ${agentId ?? "main"}`);
			return {
				modelProvider: metadata.modelProvider,
				modelId: metadata.modelId,
				thinkingLevel: metadata.thinkingLevel,
			};
		},
		readTerminalOutboxStatuses(agentId) {
			const db = createSqliteDatabase(getControlDbPath(options.paths.agentDir));
			try {
				const rows = db
					.prepare(
						`SELECT status FROM multi_agent_terminal_outbox
						 WHERE session_path = ? AND agent_id = ?
						 ORDER BY terminal_revision ASC`,
					)
					.all(options.context.sessionFile, agentId) as Array<{ status: string }>;
				return rows.map((row) => row.status);
			} finally {
				db.close();
			}
		},
		writeRunningGoal(objective) {
			writeSessionGoal(
				getControlDbPath(options.paths.agentDir),
				options.context.sessionFile,
				JSON.stringify({ branch: "headless", createdAt: new Date().toISOString(), objective }),
			);
		},
		readGoal() {
			const goalJson = readSessionGoal(getControlDbPath(options.paths.agentDir), options.context.sessionFile);
			return goalJson ? (JSON.parse(goalJson) as Record<string, unknown>) : undefined;
		},
		countSupervisorRequests(kind) {
			const db = createSqliteDatabase(getControlDbPath(options.paths.agentDir));
			try {
				db.exec("PRAGMA busy_timeout = 1000");
				const row = db.prepare("SELECT COUNT(*) AS count FROM supervisor_requests WHERE kind = ?").get(kind) as {
					count: number;
				};
				return row.count;
			} finally {
				db.close();
			}
		},
		countExtensionUiRequests: (predicate = () => true) => options.uiRequests.filter(predicate).length,
		async waitForSessionEntry(agentId, predicate) {
			const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
			while (Date.now() < deadline) {
				if (options.disposeController.signal.aborted) throw new Error("Headless Pi fixture disposed");
				const entry = SessionManager.open(resolveHeadlessSessionFile(options, agentId))
					.getEntries()
					.find(predicate);
				if (entry) return entry;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error(`Timed out waiting for session entry. Stderr: ${options.clientControl.client.getStderr()}`);
		},
		waitForEvent,
		waitForExtensionError: (predicate = () => true) => waitForExtensionError(predicate),
		waitForExtensionUiRequest: (predicate = () => true) => waitForUiRequest(predicate),
		waitForLlmRequest: (predicate = () => true, timeoutMs) => waitForRequest(predicate, timeoutMs),
		async waitForSupervisorRequest(kind) {
			const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
			while (Date.now() < deadline) {
				const request = claimNextSupervisorRequest(getControlDbPath(options.paths.agentDir), randomUUID());
				if (request) {
					if (request.kind !== kind) throw new Error(`Expected ${kind}, received ${request.kind}`);
					return request;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error(`Timed out waiting for Supervisor request ${kind}`);
		},
		respondToSupervisorRequest(request, response) {
			if (!request.claimToken) throw new Error(`Supervisor request ${request.id} has no claim token`);
			completeSupervisorRequest(getControlDbPath(options.paths.agentDir), request.id, request.claimToken, response);
		},
		respondToLlmRequest(requestId, message) {
			const providerSocket = options.provider.getSocket();
			if (!providerSocket) throw new Error("Headless faux provider is not connected");
			providerSocket.write(`${JSON.stringify({ type: "response", requestId, message })}\n`);
		},
		waitForAgent: (predicate) => pollStore((store) => store.listAgents().find(predicate), "agent"),
		waitForMailboxMessage: (predicate) =>
			pollStore((store) => store.listMailboxMessages().find(predicate), "mailbox message"),
		async dispose() {
			options.disposeController.abort();
			options.clientControl.unsubscribeEvents();
			await cleanupHeadlessRuntimeResources(
				[...sharedSessions].map((shared) => () => shared.dispose()),
				() =>
					cleanupHeadlessPiResources({
						stopClient: () => options.clientControl.client.stop(),
						terminateDetachedRunners: () =>
							terminateHeadlessDetachedRunners(options.paths, options.context.sessionFile),
						destroyProviderSocket: () => options.provider.getSocket()?.destroy(),
						closeProviderServer: () => closeServer(options.provider.server),
						removeTempDir: () => rmSync(options.paths.tempDir, { recursive: true, force: true }),
					}),
			);
		},
	};
}

async function startHeadlessPi(fixtureOptions: HeadlessPiOptions = {}): Promise<HeadlessPiRuntime> {
	const paths = createHeadlessPaths(defaultHeadlessPathOperations, fixtureOptions.provider);
	const testExtensionDir = join(paths.agentDir, "extensions");
	mkdirSync(testExtensionDir, { recursive: true });
	writeFileSync(
		join(testExtensionDir, "selected-runtime-target.ts"),
		`import { Type } from "typebox";
export default function(pi) {
	pi.registerCommand("model", {
		description: "Set model through the selected runtime target command context",
		handler: async (_args, ctx) => {
			await ctx.setModel({
				api: "headless-faux",
				id: "headless-faux-reasoning",
				name: "Headless Faux Reasoning",
				provider: "headless-faux",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			});
			ctx.setThinkingLevel("high");
		},
	});
	pi.registerTool({
		name: "test_set_viewed_model",
		description: "Set model through the selected runtime target adapter",
		parameters: Type.Object({}),
		execute: async () => {
			await pi.callCommand("model");
			return { content: [{ type: "text", text: "model and effort set" }], details: {} };
		},
	});
}`,
	);

	const approvalPreset = fixtureOptions.approvalPreset ?? "auto-approve";
	const approval = findApprovalPreset(approvalPreset);
	writeFileSync(
		join(paths.agentDir, "settings.json"),
		JSON.stringify({
			approvalPolicy: approval.policy,
			approvalPreset,
			sandboxProfile: fixtureOptions.sandboxProfile,
			agents: { background: { context: "fresh" } },
		}),
	);
	const context: HeadlessSessionContext = { mainSessionId: "", sessionFile: "" };
	const disposeController = new AbortController();
	const events: AgentEvent[] = [];
	const eventListeners = new Set<() => void>();
	const extensionErrors: HeadlessRpcExtensionError[] = [];
	const extensionErrorListeners = new Set<() => void>();
	const uiRequests: RpcExtensionUIRequest[] = [];
	const uiRequestListeners = new Set<() => void>();
	const requests: HeadlessLlmRequest[] = [];
	const requestListeners = new Set<() => void>();
	const resolveAgentId = (sessionId: string | undefined): string | null => {
		if (!sessionId || sessionId === context.mainSessionId) return null;
		return (
			readHeadlessStore(paths.agentDir, context.sessionFile)
				.listAgents()
				.find((agent) => agent.transcript?.sessionId === sessionId)?.id ?? null
		);
	};
	const recordRequest = createRequestRecorder({ requests, listeners: requestListeners, resolveAgentId });
	let provider: ProviderServerControl | undefined;
	let client: RpcClient | undefined;
	let unsubscribeEvents = (): void => {};
	try {
		provider = await createProviderServer(paths.socketPath, recordRequest);
		client = createHeadlessRpcClient(paths, fixtureOptions);
		unsubscribeEvents = subscribeHeadlessRpcOutput(client, {
			events,
			eventListeners,
			extensionErrors,
			extensionErrorListeners,
			uiRequests,
			uiRequestListeners,
		});
		await startRpcClientSession(client, context);
	} catch (error) {
		unsubscribeEvents();
		return runWithCleanup(
			async () => {
				throw error;
			},
			() => cleanupHeadlessStartup(paths, client, provider),
		);
	}

	const clientControl = { client, unsubscribeEvents };
	return createHeadlessRuntime({
		paths,
		fixtureOptions,
		clientControl,
		provider,
		disposeController,
		events,
		eventListeners,
		extensionErrors,
		extensionErrorListeners,
		uiRequests,
		uiRequestListeners,
		requests,
		requestListeners,
		context,
	});
}

export async function withHeadlessPi<T>(
	run: (agent: HeadlessPi) => Promise<T>,
	options: HeadlessPiOptions = {},
): Promise<T> {
	const agent = await startHeadlessPi(options);
	return runWithCleanup(
		() => run(agent),
		() => agent.dispose(),
	);
}
