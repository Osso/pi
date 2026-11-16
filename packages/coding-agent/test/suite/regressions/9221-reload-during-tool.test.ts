import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { fauxProviderConfig } from "../harness.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// Regression for https://github.com/earendil-works/pi/issues/9221: RPC and print-mode ctx.reload() call the
// runtime directly, without the interactive /reload checks.
describe("reload during a running tool", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("rejects the reload and keeps the running tool's context usable", async () => {
		const tempDir = join(tmpdir(), `pi-9221-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const started = deferred();
		const released = deferred();

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi) => {
							pi.registerProvider(faux.getModel().provider, fauxProviderConfig(faux));
							pi.registerTool({
								name: "wait_then_succeed",
								label: "Wait then succeed",
								description: "Use the tool context after waiting",
								parameters: Type.Object({}),
								execute: async (_id, _params, _signal, _update, ctx) => {
									started.resolve();
									await released.promise;
									ctx.getSystemPrompt();
									return { content: [{ type: "text", text: "tool succeeded" }], details: {} };
								},
							});
						},
					],
					noSkills: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		});
		cleanups.push(() => {
			runtime.session.dispose();
			faux.unregister();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("wait_then_succeed", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "done" }), { stopReason: "toolUse" }),
		]);

		const prompt = runtime.session.prompt("run the tool");
		await started.promise;
		try {
			await expect(runtime.reload()).rejects.toThrow("Wait for the current response to finish before reloading.");
		} finally {
			released.resolve();
			await prompt;
		}

		const toolResults = runtime.session.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []))
			.filter((message) => message.toolName === "wait_then_succeed");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toMatchObject({ isError: false, content: [{ type: "text", text: "tool succeeded" }] });
	});
});
