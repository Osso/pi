import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	AgentSession,
	createMultiAgentExecutionCapability,
	type MultiAgentRuntimeRole,
} from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function constructSession(role: MultiAgentRuntimeRole, withCapability: boolean): AgentSession {
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	return new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "test", tools: [], thinkingLevel: "off" },
		}),
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		multiAgentExecutionCapability: withCapability ? createMultiAgentExecutionCapability() : undefined,
		multiAgentRuntimeRole: role,
		resourceLoader: createTestResourceLoader(),
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory(),
	});
}

describe("AgentSession multi-agent runtime roles", () => {
	it("rejects an orchestrator before construction when execution capability is missing", () => {
		expect(() => constructSession("orchestrator", false)).toThrow(/execution capability/i);
	});

	it("rejects a child before construction when execution capability is present", () => {
		expect(() => constructSession("child", true)).toThrow(/child.*execution capability/i);
	});
});
