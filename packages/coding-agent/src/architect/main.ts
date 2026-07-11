import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import agentsMailboxExtension from "../../extensions/agents-mailbox/src/index.ts";
import bwrapExtension from "../../extensions/bwrap/src/index.ts";
import { getAgentDir } from "../config.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import { ModelRegistry } from "../core/model-registry.ts";
import { MultiAgentStore } from "../core/multi-agent-store.ts";
import { createAgentSession } from "../core/sdk.ts";
import { archiveSession, getControlDbPath } from "../core/session-control-db.ts";
import { SessionManager } from "../core/session-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { ArchitectObserver } from "./observer.ts";
import { ARCHITECT_SYSTEM_PROMPT, buildArchitectPrompt } from "./prompt.ts";

const OBSERVER_INTERVAL_MS = 30_000;
const REQUEST_CLAIM_RENEW_INTERVAL_MS = 30_000;
const ARCHITECT_SESSION_ID = "architect";
const ARCHITECT_REQUEST_THREAD_PREFIX = "architect-request:";

export function createArchitectSettingsManager(): SettingsManager {
	return SettingsManager.inMemory({ sandboxProfile: "read-only" });
}

export function createArchitectMultiAgentStore(sessionManager: SessionManager, agentDir: string): MultiAgentStore {
	const controlDbPath = getControlDbPath(agentDir);
	sessionManager.setMetadataControlDbPath(controlDbPath);
	const sessionPath = sessionManager.getSessionFile();
	if (sessionPath) {
		archiveSession(controlDbPath, sessionPath);
	}
	return MultiAgentStore.fromSessionManager(sessionManager);
}

export function completeSentArchitectRequest(
	observer: Pick<ArchitectObserver, "completeRequest">,
	input: { threadId?: string; toAgentId: string; toSessionId: string },
): void {
	if (input.toAgentId !== "main" || !input.threadId?.startsWith(ARCHITECT_REQUEST_THREAD_PREFIX)) return;
	const requestId = Number(input.threadId.slice(ARCHITECT_REQUEST_THREAD_PREFIX.length));
	if (!Number.isSafeInteger(requestId) || requestId < 1) return;
	observer.completeRequest(requestId, input.toSessionId);
}

export function blockArchitectGlobalBroadcast(event: {
	input: unknown;
	toolName: string;
}): { block: true; reason: string } | undefined {
	if (event.toolName === "channel_post") {
		return { block: true, reason: "Pi Architect must use direct agent messaging, not channel_post." };
	}
	if (event.toolName === "list_sessions") {
		return {
			block: true,
			reason: "Pi Architect must use its bounded structured observer snapshot, not list_sessions.",
		};
	}
	if (event.toolName === "broadcast") {
		return { block: true, reason: "Pi Architect must use direct agent messaging, not broadcast." };
	}
	return undefined;
}

export async function runArchitectCycle(
	observer: Pick<ArchitectObserver, "observe"> & Partial<Pick<ArchitectObserver, "renewRequests">>,
	prompt: (content: string) => Promise<void>,
): Promise<void> {
	const observation = observer.observe();
	if (!observation) return;
	const requestIds = observation.requests.map((request) => request.id);
	const renewTimer =
		requestIds.length > 0 && observer.renewRequests
			? setInterval(() => observer.renewRequests?.(requestIds), REQUEST_CLAIM_RENEW_INTERVAL_MS)
			: undefined;
	renewTimer?.unref();
	try {
		await prompt(buildArchitectPrompt(observation));
	} finally {
		if (renewTimer) clearInterval(renewTimer);
	}
}

export function createArchitectStopHandler(params: {
	abortController: AbortController;
	abortSession: () => Promise<void>;
	exit: (code: number) => void;
}): () => void {
	let stopping = false;
	return () => {
		if (stopping) return;
		stopping = true;
		params.abortController.abort();
		void params.abortSession();
		const forceExit = setTimeout(() => params.exit(0), 5_000);
		forceExit.unref();
	};
}

export function waitForArchitectInterval(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timeout = setTimeout(done, OBSERVER_INTERVAL_MS);
		function done() {
			clearTimeout(timeout);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

export async function runArchitectService(): Promise<void> {
	const agentDir = getAgentDir();
	const cwd = process.env.HOME ?? process.cwd();
	const sessionDir = join(agentDir, "architect-sessions");
	mkdirSync(sessionDir, { recursive: true });
	const existingSessionFile = readdirSync(sessionDir)
		.filter((file) => file.endsWith(`_${ARCHITECT_SESSION_ID}.jsonl`))
		.sort()
		.at(-1);
	const sessionPath = existingSessionFile
		? join(sessionDir, existingSessionFile)
		: join(sessionDir, `${ARCHITECT_SESSION_ID}.jsonl`);
	const sessionManager = existsSync(sessionPath)
		? SessionManager.open(sessionPath, sessionDir, cwd)
		: SessionManager.create(cwd, sessionDir, { id: ARCHITECT_SESSION_ID });
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	const model = modelRegistry.find("openai-codex", "gpt-5.6-sol");
	if (!model) {
		throw new Error("Pi Architect requires openai-codex/gpt-5.6-sol");
	}
	const settingsManager = createArchitectSettingsManager();
	const multiAgentStore = createArchitectMultiAgentStore(sessionManager, agentDir);
	const observer = new ArchitectObserver();
	const { session } = await createAgentSession({
		agentDir,
		authStorage,
		cwd,
		disableRuntimeCoordinationInbound: true,
		extensionFactories: [
			(pi) =>
				agentsMailboxExtension(pi, {
					onSessionMessageSent: ({ message, toSessionId }) =>
						completeSentArchitectRequest(observer, {
							threadId: message.threadId,
							toAgentId: message.toAgentId,
							toSessionId,
						}),
					store: multiAgentStore,
				}),
			bwrapExtension,
			(pi) => {
				pi.on("before_agent_start", (event) => ({
					systemPrompt: `${event.systemPrompt}\n\n${ARCHITECT_SYSTEM_PROMPT}`,
				}));
				pi.registerToolGate((event) => blockArchitectGlobalBroadcast(event));
			},
		],
		model,
		modelRegistry,
		excludeTools: ["ask_architect", "broadcast", "contact_supervisor"],
		multiAgentStore,
		sessionManager,
		settingsManager,
		thinkingLevel: "high",
	});
	const abortController = new AbortController();
	const stop = createArchitectStopHandler({
		abortController,
		abortSession: () => session.abort(),
		exit: (code) => process.exit(code),
	});
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	while (!abortController.signal.aborted) {
		await runArchitectCycle(observer, (content) => session.prompt(content));
		await waitForArchitectInterval(abortController.signal);
	}
}
