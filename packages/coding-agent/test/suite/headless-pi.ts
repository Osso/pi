import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai/compat";
import type { AgentMailboxMessage, AgentSnapshot } from "../../src/core/multi-agent-store.ts";
import { MultiAgentStore } from "../../src/core/multi-agent-store.ts";
import { getControlDbPath } from "../../src/core/session-control-db.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { RpcClient, type RpcCommandBody } from "../../src/modes/rpc/rpc-client.ts";
import type { RpcResponse } from "../../src/modes/rpc/rpc-types.ts";

const DEFAULT_TIMEOUT_MS = 10_000;

interface WireLlmRequest {
	type: "request";
	id: string;
	sessionId?: string;
	messages: Message[];
}

export interface HeadlessLlmRequest {
	id: string;
	sessionId?: string;
	agentId: string | null;
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

export interface HeadlessPi {
	paths: HeadlessPiPaths;
	send(command: RpcCommandBody): Promise<RpcResponse>;
	waitForEvent(predicate: (event: AgentEvent) => boolean): Promise<AgentEvent>;
	waitForLlmRequest(predicate?: (request: HeadlessLlmRequest) => boolean): Promise<HeadlessLlmRequest>;
	respondToLlmRequest(requestId: string, message: AssistantMessage): void;
	waitForAgent(predicate: (agent: AgentSnapshot) => boolean): Promise<AgentSnapshot>;
	waitForMailboxMessage(predicate: (message: AgentMailboxMessage) => boolean): Promise<AgentMailboxMessage>;
}

interface HeadlessPiRuntime extends HeadlessPi {
	dispose(): Promise<void>;
}

function createModelsJson(): string {
	return JSON.stringify({
		providers: {
			"headless-faux": {
				api: "headless-faux",
				apiKey: "test-key",
				baseUrl: "http://localhost:0",
				models: [
					{
						id: "headless-faux-1",
						name: "Headless Faux",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 16384,
					},
				],
			},
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
		operations.writeModelsJson(join(paths.agentDir, "models.json"), createModelsJson());
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

async function createProviderServer(
	socketPath: string,
	recordRequest: (request: WireLlmRequest) => void,
): Promise<ProviderServerControl> {
	let providerSocket: Socket | undefined;
	let inputBuffer = "";
	const server = createServer((socket) => {
		providerSocket = socket;
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

function createHeadlessRpcClient(paths: HeadlessRuntimePaths): RpcClient {
	const preloadPath = join(import.meta.dirname, "fixtures", "headless-pi-provider-preload.ts");
	const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
	return new RpcClient({
		cliPath,
		cwd: paths.workspaceDir,
		env: {
			PI_CODING_AGENT_DIR: paths.agentDir,
			PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
			PI_HEADLESS_PROVIDER_SOCKET: paths.socketPath,
		},
		provider: "headless-faux",
		model: "headless-faux-1",
		nodeArgs: ["--import", import.meta.resolve("tsx"), "--import", pathToFileURL(preloadPath).href],
		args: ["--approve", "--no-context-files", "--no-skills", "--no-themes"],
	});
}

interface HeadlessPiCleanupOperations {
	stopClient: () => Promise<void>;
	destroyProviderSocket: () => void;
	closeProviderServer: () => Promise<void>;
	removeTempDir: () => void;
}

export async function cleanupHeadlessPiResources(operations: HeadlessPiCleanupOperations): Promise<void> {
	const errors: unknown[] = [];
	for (const cleanup of [
		operations.stopClient,
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
		}, DEFAULT_TIMEOUT_MS);
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

function createHeadlessRuntime(options: {
	paths: HeadlessRuntimePaths;
	client: RpcClient;
	provider: ProviderServerControl;
	disposeController: AbortController;
	events: AgentEvent[];
	eventListeners: Set<() => void>;
	requests: HeadlessLlmRequest[];
	requestListeners: Set<() => void>;
	context: HeadlessSessionContext;
	unsubscribeEvents: () => void;
}): HeadlessPiRuntime {
	const waitForEvent = (predicate: (event: AgentEvent) => boolean): Promise<AgentEvent> =>
		waitForBufferedItem({
			items: options.events,
			listeners: options.eventListeners,
			predicate,
			disposeSignal: options.disposeController.signal,
			timeoutError: () => new Error(`Timed out waiting for RPC event. Stderr: ${options.client.getStderr()}`),
		});
	const waitForRequest = (predicate: (request: HeadlessLlmRequest) => boolean): Promise<HeadlessLlmRequest> =>
		waitForBufferedItem({
			items: options.requests,
			listeners: options.requestListeners,
			predicate,
			disposeSignal: options.disposeController.signal,
			timeoutError: () => new Error(`Timed out waiting for LLM request. Stderr: ${options.client.getStderr()}`),
		});
	const pollStore = createStorePoller({
		agentDir: options.paths.agentDir,
		getSessionFile: () => options.context.sessionFile,
		disposeSignal: options.disposeController.signal,
		getStderr: () => options.client.getStderr(),
	});

	return {
		paths: {
			tempDir: options.paths.tempDir,
			agentDir: options.paths.agentDir,
			sessionDir: options.paths.sessionDir,
			workspaceDir: options.paths.workspaceDir,
		},
		send: (command) => options.client.send(command),
		waitForEvent,
		waitForLlmRequest: (predicate = () => true) => waitForRequest(predicate),
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
			options.unsubscribeEvents();
			await cleanupHeadlessPiResources({
				stopClient: () => options.client.stop(),
				destroyProviderSocket: () => options.provider.getSocket()?.destroy(),
				closeProviderServer: () => closeServer(options.provider.server),
				removeTempDir: () => rmSync(options.paths.tempDir, { recursive: true, force: true }),
			});
		},
	};
}

async function startHeadlessPi(): Promise<HeadlessPiRuntime> {
	const paths = createHeadlessPaths();
	const context: HeadlessSessionContext = { mainSessionId: "", sessionFile: "" };
	const disposeController = new AbortController();
	const events: AgentEvent[] = [];
	const eventListeners = new Set<() => void>();
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
		client = createHeadlessRpcClient(paths);
		unsubscribeEvents = client.onEvent((event) => {
			events.push(event);
			for (const listener of eventListeners) listener();
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

	return createHeadlessRuntime({
		paths,
		client,
		provider,
		disposeController,
		events,
		eventListeners,
		requests,
		requestListeners,
		context,
		unsubscribeEvents,
	});
}

export async function withHeadlessPi<T>(run: (agent: HeadlessPi) => Promise<T>): Promise<T> {
	const agent = await startHeadlessPi();
	return runWithCleanup(
		() => run(agent),
		() => agent.dispose(),
	);
}
