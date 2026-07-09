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
	const settingsManager = SettingsManager.inMemory({ sandboxProfile: "read-only" });
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
			},
		],
		model,
		modelRegistry,
		sessionManager,
		settingsManager,
		thinkingLevel: "high",
	});
	const observer = new ArchitectObserver();
	let stopping = false;
	const stop = () => {
		stopping = true;
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	while (!stopping) {
		const observation = observer.observe();
		if (observation) {
			await session.prompt(buildArchitectPrompt(observation));
		}
		await new Promise<void>((resolve) => setTimeout(resolve, OBSERVER_INTERVAL_MS));
	}
}
