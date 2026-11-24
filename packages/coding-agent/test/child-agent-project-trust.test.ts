import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProductionChildAgentSessionFactory } from "../extensions/agents-core/src/runtime.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSnapshot } from "../src/core/multi-agent-store.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function createAgent(cwd: string): AgentSnapshot {
	return {
		agentType: "explore",
		createdAt: "2026-11-23T00:00:00.000Z",
		cwd,
		displayName: "trust probe",
		id: "trust-child",
		lifecycle: "running",
		parentId: "main",
		permission: { narrowed: true, policy: "on-request" },
		revision: 1,
		updatedAt: "2026-11-23T00:00:00.000Z",
	};
}

async function spawnChild(parent: Harness): Promise<AgentSession> {
	const children: AgentSession[] = [];
	cleanups.push(() => {
		for (const child of children) child.dispose();
	});
	await createProductionChildAgentSessionFactory({
		agentDir: join(parent.tempDir, "agent"),
		// The real resource loader runs, so project rules load only when the child's settings trust the project.
		createSession: async (options) => {
			const result = await createAgentSession({ ...options, authStorage: parent.authStorage });
			children.push(result.session);
			return result;
		},
		createSessionManager: SessionManager.create,
		extensionFactories: [],
		multiAgentStore: new MultiAgentStore(),
	})({
		agent: createAgent(parent.tempDir),
		context: "fresh",
		ctx: parent.session.extensionRunner.createContext(),
		prompt: "Probe project trust",
	});
	const child = children[0];
	if (!child) throw new Error("Expected a child session");
	return child;
}

describe("child agent project trust", () => {
	it.each([
		{ parentTrusted: false, loadsProjectRules: false },
		{ parentTrusted: true, loadsProjectRules: true },
	])("follows the parent's project trust in the same cwd: %j", async ({ parentTrusted, loadsProjectRules }) => {
		const parent = await createHarness({ persistedSession: true });
		cleanups.push(() => parent.cleanup());
		mkdirSync(join(parent.tempDir, ".pi", "rules"), { recursive: true });
		writeFileSync(join(parent.tempDir, ".pi", "rules", "rule.md"), "PROJECT_TRUST_PROBE\n");
		parent.settingsManager.setProjectTrusted(parentTrusted);

		const child = await spawnChild(parent);

		expect(child.systemPrompt.includes("PROJECT_TRUST_PROBE")).toBe(loadsProjectRules);
	});
});
