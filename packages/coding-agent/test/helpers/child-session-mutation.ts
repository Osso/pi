import type { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ViewedSessionMutationTarget } from "../../src/core/extensions/types.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";

export function createChildSessionMutationFixture(): ViewedSessionMutationTarget & Pick<AgentSession, "cycleModel"> {
	return {
		model: undefined,
		thinkingLevel: "off",
		modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
		scopedModels: [],
		async setModel(model) {
			this.model = model;
		},
		setThinkingLevel(level) {
			this.thinkingLevel = level;
		},
		async cycleModel() {
			throw new Error("Model cycling is not configured in this fixture");
		},
	};
}
