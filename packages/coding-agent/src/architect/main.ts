import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import bwrapExtension from "../../extensions/bwrap/src/index.ts";
import { getAgentDir } from "../config.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import { ModelRegistry } from "../core/model-registry.ts";
import { createAgentSession } from "../core/sdk.ts";
import { SessionManager } from "../core/session-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { ArchitectObserver } from "./observer.ts";
import { ARCHITECT_SYSTEM_PROMPT, buildArchitectPrompt } from "./prompt.ts";

const OBSERVER_INTERVAL_MS = 30_000;
const ARCHITECT_SESSION_ID = "architect";

export function createArchitectSettingsManager(): SettingsManager {
	return SettingsManager.inMemory({ sandboxProfile: "read-only" });
}

export function blockArchitectGlobalBroadcast(event: {
	input: unknown;
	toolName: string;
}): { block: true; reason: string } | undefined {
	if (event.toolName === "channel_post") {
		return { block: true, reason: "Pi Architect must target one affected session with broadcast, not channel_post." };
	}
	if (event.toolName !== "broadcast") return undefined;
	const sessionIds =
		typeof event.input === "object" && event.input !== null && "session_ids" in event.input
			? (event.input as { session_ids?: unknown }).session_ids
			: undefined;
	if (!Array.isArray(sessionIds) || sessionIds.length !== 1 || !sessionIds.every((id) => typeof id === "string")) {
		return { block: true, reason: "Pi Architect broadcast requires exactly one affected session_id." };
	}
	return undefined;
}

export async function runArchitectCycle(
	observer: Pick<ArchitectObserver, "observe">,
	prompt: (content: string) => Promise<void>,
): Promise<void> {
	const observation = observer.observe();
	if (observation) {
		await prompt(buildArchitectPrompt(observation));
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
	const sessionPath = join(sessionDir, `${ARCHITECT_SESSION_ID}.jsonl`);
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
	const { session } = await createAgentSession({
		agentDir,
		authStorage,
		cwd,
		extensionFactories: [
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
		sessionManager,
		settingsManager,
		thinkingLevel: "high",
	});
	const observer = new ArchitectObserver();
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
