import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDurableDetachablePyrunEvaluation } from "../extensions/pyrun/src/detached-evaluation.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { getControlDbPath, readMultiAgentState } from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { deliverTerminalOutboxProjections } from "../src/core/terminal-outbox-delivery.ts";
import { ToolDetachRegistry } from "../src/core/tool-detach-registry.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("durable detached Pyrun evaluation", () => {
	it("settles the original call to a handle while the independent runner completes", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-pyrun-evaluation-"));
		temporaryDirectories.push(root);
		const runnerPath = join(root, "fake-pyrun.mjs");
		writeFileSync(
			runnerPath,
			[
				"#!/usr/bin/env node",
				"import { createInterface } from 'node:readline';",
				"const lines = createInterface({ input: process.stdin });",
				"for await (const line of lines) {",
				"  const request = JSON.parse(line);",
				"  process.stdout.write(JSON.stringify({ type: 'progress', message: 'started' }) + '\\n');",
				"  await new Promise((resolve) => setTimeout(resolve, 150));",
				"  process.stdout.write(JSON.stringify({ type: 'completed', executed: request.code, value: 42 }) + '\\n');",
				"}",
			].join("\n"),
		);
		chmodSync(runnerPath, 0o700);
		const sessionManager = SessionManager.create(root, join(root, "sessions"));
		const controlDbPath = getControlDbPath(root);
		sessionManager.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore();
		store.setPersistenceSessionManager(sessionManager);
		const sessionPath = sessionManager.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted Pyrun test session");
		const detachRegistry = new ToolDetachRegistry();
		const evaluation = runDurableDetachablePyrunEvaluation({
			ctx: {
				controlDbPath,
				cwd: root,
				footerData: undefined,
				getContextUsage: () => undefined,
				model: undefined,
				sessionManager,
			} as unknown as ExtensionContext,
			detachRegistry,
			params: { code: "6 * 7" },
			piBridgeEnabled: false,
			runnerOptions: { command: runnerPath },
			store,
		});
		await waitFor(() => detachRegistry.detachRunning());
		const result = await evaluation;
		expect(result.details).toMatchObject({ backgroundJobId: "agent_1" });
		await waitFor(() => {
			const agent = readMultiAgentState(controlDbPath, sessionPath)?.agents[0] as
				| { lifecycle?: unknown }
				| undefined;
			return agent?.lifecycle === "completed";
		});
		expect(store.getAgent("agent_1")?.lifecycle).toBe("running");
		expect(store.listMailboxMessages()).toHaveLength(0);
		const unsubscribeFailure = store.subscribeLifecycleNotifications(() => {
			throw new Error("transport unavailable");
		});
		expect(() =>
			deliverTerminalOutboxProjections({
				claimId: "failed-projection",
				controlDbPath,
				now: () => new Date().toISOString(),
				store,
			}),
		).toThrow("transport unavailable");
		unsubscribeFailure();
		expect(store.listMailboxMessages()).toHaveLength(1);
		const retriedNotifications: string[] = [];
		const unsubscribeRetry = store.subscribeLifecycleNotifications((message) => {
			retriedNotifications.push(message.id);
		});
		expect(
			deliverTerminalOutboxProjections({
				claimId: "test-projection",
				controlDbPath,
				now: () => new Date().toISOString(),
				store,
			}),
		).toBe(1);
		unsubscribeRetry();
		expect(retriedNotifications).toHaveLength(1);
		expect(store.getAgent("agent_1")?.lifecycle).toBe("completed");
		expect(store.listMailboxMessages()).toMatchObject([
			{ fromAgentId: "agent_1", status: "pending", threadId: "agent-completed:agent_1" },
		]);
		expect(
			deliverTerminalOutboxProjections({
				claimId: "test-projection",
				controlDbPath,
				now: () => new Date().toISOString(),
				store,
			}),
		).toBe(0);
		expect(store.listMailboxMessages()).toHaveLength(1);
	});
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for durable Pyrun evaluation");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
