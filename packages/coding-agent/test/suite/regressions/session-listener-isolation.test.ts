import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	createAgentSessionFromServices,
} from "../../../src/core/agent-session-runtime.ts";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import { ResidentConsoleClient, ResidentConsoleServer } from "../../../src/core/resident-console-transport.ts";
import { legacyMultiAgentStore } from "../../helpers/legacy-multi-agent-store.ts";
import { createHarness } from "../harness.ts";

describe("session listener isolation", () => {
	it("finishes abort and runtime replacement after a queue subscriber throws", async () => {
		const harness = await createHarness({ persistedSession: true });
		const failure = new Error("queue subscriber failed");
		const report = vi.spyOn(console, "error").mockImplementation(() => {});
		const services: AgentSessionServices = {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: harness.authStorage,
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		};
		const runtime = new AgentSessionRuntime(harness.session, services, async ({ sessionManager }) => ({
			...(await createAgentSessionFromServices({ services, sessionManager, model: harness.getModel() })),
			services,
			diagnostics: [],
		}));
		try {
			const outgoing = runtime.session;
			const deliveries: string[] = [];
			outgoing.subscribe((event) => {
				if (event.type !== "queue_update") return;
				deliveries.push("throwing");
				throw failure;
			});
			outgoing.subscribe((event) => {
				if (event.type === "queue_update") deliveries.push("recording");
			});

			await outgoing.abort();
			expect(deliveries).toEqual(["throwing", "recording"]);
			expect(report).toHaveBeenCalledWith("Session event listener error (queue_update):", failure);
			expect(await runtime.newSession()).toEqual({ cancelled: false });
			expect(runtime.session).not.toBe(outgoing);
			expect(() => outgoing.extensionRunner.createContext().model).toThrow(/stale/);
			await outgoing.abort();
			expect(deliveries).toEqual(["throwing", "recording"]);
			harness.setResponses([
				fauxAssistantMessage(
					[{ type: "text", text: "replacement works" }, fauxToolCall("end_turn", { reason: "done" })],
					{ stopReason: "toolUse" },
				),
			]);
			await runtime.session.prompt("continue in replacement");
			expect(runtime.session.messages).toContainEqual(
				expect.objectContaining({
					role: "assistant",
					content: expect.arrayContaining([{ type: "text", text: "replacement works" }]),
				}),
			);
			expect(runtime.session.agent.state.errorMessage).toBeUndefined();
		} finally {
			await runtime.dispose();
			harness.cleanup();
			report.mockRestore();
		}
	});

	it.each(["throw", "reject"])("finishes agent runs when an awaited subscriber fails: %s", async (mode) => {
		const harness = await createHarness();
		const report = vi.spyOn(console, "error").mockImplementation(() => {});
		const failure = new Error("agent subscriber failed");
		try {
			const deliveries: string[] = [];
			harness.session.agent.subscribe((event) => {
				if (event.type !== "agent_end") return;
				deliveries.push("throwing");
				if (mode === "reject") return Promise.reject(failure);
				throw failure;
			});
			harness.session.agent.subscribe((event) => {
				if (event.type === "agent_end") deliveries.push("recording");
			});
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("end_turn", { reason: "first" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("end_turn", { reason: "second" }), { stopReason: "toolUse" }),
			]);
			await harness.session.prompt("one");
			await harness.session.agent.waitForIdle();
			await harness.session.prompt("two");
			expect(deliveries).toEqual(["throwing", "recording", "throwing", "recording"]);
			expect(harness.eventsOfType("agent_end")).toHaveLength(2);
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(harness.session.agent.state.errorMessage).toBeUndefined();
			expect(report).toHaveBeenCalledWith("Agent event listener error (agent_end):", failure);
		} finally {
			harness.cleanup();
			report.mockRestore();
		}
	});

	it("continues extension dispatch after an error subscriber throws", async () => {
		const handlerFailure = new Error("extension handler failed");
		const listenerFailure = new Error("error subscriber failed");
		const deliveries: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_switch", () => {
						throw handlerFailure;
					});
					pi.on("session_before_switch", () => {
						deliveries.push("next handler");
					});
				},
			],
		});
		const report = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const runner = harness.session.extensionRunner;
			runner.onError(() => {
				deliveries.push("throwing");
				throw listenerFailure;
			});
			runner.onError((error) => {
				deliveries.push(error.error);
			});
			await runner.emit({ type: "session_before_switch", reason: "new" });
			expect(deliveries).toEqual(["throwing", handlerFailure.message, "next handler"]);
			expect(report).toHaveBeenCalledWith("Extension error listener failed:", listenerFailure);
		} finally {
			harness.cleanup();
			report.mockRestore();
		}
	});

	it.each(["notification", "transition"])(
		"completes terminal publication after a throwing %s subscriber",
		async (site) => {
			const harness = await createHarness({ persistedSession: true });
			const report = vi.spyOn(console, "error").mockImplementation(() => {});
			const failure = new Error("store subscriber failed");
			try {
				const store = MultiAgentStore.fromSessionManager(harness.sessionManager);
				const { agent } = legacyMultiAgentStore(store).spawnAgent({
					agentType: "scout",
					cwd: harness.tempDir,
					displayName: "Scout",
					permission: { narrowed: true, policy: "on-request" },
				});
				const deliveries: string[] = [];
				store.subscribeLifecycleNotifications(() => {
					if (site === "notification") {
						deliveries.push("throwing notification");
						throw failure;
					}
				});
				store.subscribeLifecycleNotifications(() => {
					deliveries.push("notification");
				});
				store.subscribeAgentTransitions(() => {
					if (site === "transition") {
						deliveries.push("throwing transition");
						throw failure;
					}
				});
				store.subscribeAgentTransitions(() => {
					deliveries.push("transition");
				});
				store.selectAgentView(agent.id);
				expect(legacyMultiAgentStore(store).transitionAgent(agent.id, agent.revision, "completed").ok).toBe(true);
				expect(deliveries).toEqual(
					site === "notification"
						? ["throwing notification", "notification", "transition"]
						: ["notification", "throwing transition", "transition"],
				);
				expect(store.getSelectedAgentId()).toBeUndefined();
				expect(store.listMailboxMessages()).toContainEqual(expect.objectContaining({ kind: "system" }));
				expect(report).toHaveBeenCalledWith(
					site === "notification"
						? "MultiAgentStore lifecycle notification listener failed:"
						: "MultiAgentStore transition listener failed:",
					failure,
				);
			} finally {
				harness.cleanup();
				report.mockRestore();
			}
		},
	);

	it("keeps resident event delivery and disconnect cleanup alive after subscriber errors", async () => {
		const harness = await createHarness();
		const failure = new Error("resident subscriber failed");
		const report = vi.spyOn(console, "error").mockImplementation(() => {});
		let emitEvent: ((event: string) => void) | undefined;
		const server = new ResidentConsoleServer<string, string>({
			socketPath: join(harness.tempDir, "console.sock"),
			service: "supervisor",
			getSnapshot: () => ({
				service: "supervisor",
				sessionId: "test",
				cwd: harness.tempDir,
				generation: 1,
				branch: [],
			}),
			enqueuePrompt: () => {},
			subscribe: (listener) => {
				emitEvent = listener;
				return () => {
					emitEvent = undefined;
				};
			},
		});
		let client: ResidentConsoleClient<string, string> | undefined;
		try {
			await server.start();
			client = await ResidentConsoleClient.connect({ socketPath: server.socketPath, service: "supervisor" });
			const deliveries: string[] = [];
			client.onEvent(() => {
				deliveries.push("throwing event");
				throw failure;
			});
			client.onEvent(({ event }) => {
				deliveries.push(event);
			});
			client.onDisconnect(() => {
				deliveries.push("throwing disconnect");
				throw failure;
			});
			client.onDisconnect(() => {
				deliveries.push("disconnect");
			});
			emitEvent?.("first");
			await vi.waitFor(() => expect(deliveries).toEqual(["throwing event", "first"]));
			await client.prompt("after-event", "connection still works");
			emitEvent?.("second");
			await vi.waitFor(() => expect(deliveries).toContain("second"));
			await client.close();
			expect(deliveries).toEqual([
				"throwing event",
				"first",
				"throwing event",
				"second",
				"throwing disconnect",
				"disconnect",
			]);
			expect(report).toHaveBeenCalledWith("Resident console event listener failed:", failure);
			expect(report).toHaveBeenCalledWith("Resident console disconnect listener failed:", failure);
		} finally {
			await client?.close();
			await server.close();
			harness.cleanup();
			report.mockRestore();
		}
	});

	it("keeps event bus handler failures isolated through the existing diagnostic channel", async () => {
		const bus = createEventBus();
		const failure = new Error("bus subscriber failed");
		const report = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const deliveries: string[] = [];
			bus.on("test", () => {
				deliveries.push("throwing");
				throw failure;
			});
			bus.on("test", () => {
				deliveries.push("recording");
			});
			bus.emit("test", {});
			await Promise.resolve();
			expect(deliveries).toEqual(["throwing", "recording"]);
			expect(report).toHaveBeenCalledWith("Event handler error (test):", failure);
		} finally {
			bus.clear();
			report.mockRestore();
		}
	});
});
