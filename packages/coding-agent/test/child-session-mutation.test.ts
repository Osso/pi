import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	bindProductionChildSession,
	type UnboundChildAgentSession,
} from "../extensions/agents-core/src/child-session.ts";
import type { ModelCycleResult } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

const firstModel: Model<Api> = {
	id: "first-model",
	name: "First model",
	provider: "test",
	api: "openai-completions",
	baseUrl: "http://localhost:1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};
const secondModel = { ...firstModel, id: "second-model" };
const thirdModel = { ...firstModel, id: "third-model" };

class LiveChildSession implements UnboundChildAgentSession {
	#model: Model<Api> | undefined = firstModel;
	#thinkingLevel: ThinkingLevel = "low";
	modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
	scopedModels = [firstModel, secondModel, thirdModel].map((model) => ({ model }));
	sessionManager = { getBranch: () => [] };
	extensionRunner = { emit: async () => {} };
	messages = [];

	get model() {
		return this.#model;
	}

	get thinkingLevel() {
		return this.#thinkingLevel;
	}

	async setModel(model: Model<Api>): Promise<void> {
		this.#model = model;
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this.#thinkingLevel = level;
	}

	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this.scopedModels.length === 0) return undefined;
		const index = this.scopedModels.findIndex(({ model }) => model === this.#model);
		const step = direction === "forward" ? 1 : -1;
		const next = this.scopedModels[(index + step + this.scopedModels.length) % this.scopedModels.length];
		await this.setModel(next.model);
		return { model: next.model, thinkingLevel: this.#thinkingLevel, isScoped: true };
	}

	async bindExtensions(): Promise<void> {}
	async prompt(): Promise<void> {}
}

describe("production child session mutation surface", () => {
	it("reads live model, effort, registry and scope rather than bind-time snapshots", async () => {
		const session = new LiveChildSession();
		const child = bindProductionChildSession(session);
		expect(child.model).toBe(firstModel);
		expect(child.thinkingLevel).toBe("low");
		expect(child.modelRegistry).toBe(session.modelRegistry);
		expect(child.scopedModels).toBe(session.scopedModels);

		await session.setModel(secondModel);
		session.setThinkingLevel("high");
		session.modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
		session.scopedModels = [{ model: thirdModel }];
		expect(child.model).toBe(secondModel);
		expect(child.thinkingLevel).toBe("high");
		expect(child.modelRegistry).toBe(session.modelRegistry);
		expect(child.scopedModels).toBe(session.scopedModels);
	});

	it("binds extracted model and effort setters to the underlying session", async () => {
		const session = new LiveChildSession();
		const { setModel, setThinkingLevel } = bindProductionChildSession(session);
		await setModel(secondModel);
		setThinkingLevel("high");
		expect(session.model).toBe(secondModel);
		expect(session.thinkingLevel).toBe("high");
	});

	it("binds model cycling and preserves direction, default and empty-scope results", async () => {
		const session = new LiveChildSession();
		const { cycleModel } = bindProductionChildSession(session);
		expect(await cycleModel("backward")).toEqual({ model: thirdModel, thinkingLevel: "low", isScoped: true });
		expect(session.model).toBe(thirdModel);
		expect(await cycleModel()).toEqual({ model: firstModel, thinkingLevel: "low", isScoped: true });
		expect(session.model).toBe(firstModel);
		session.scopedModels = [];
		expect(await cycleModel("forward")).toBeUndefined();
	});
});
