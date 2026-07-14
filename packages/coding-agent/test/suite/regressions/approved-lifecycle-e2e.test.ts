import { rmSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { LifecycleCoordinator } from "../../../src/core/lifecycle-coordinator.ts";
import { MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import { getControlDbPath } from "../../../src/core/session-control-db.ts";
import multiAgentExtension, {
	type AttachedSessionFactory,
	type ChildAgentSessionFactory,
	createMultiAgentRuntimeHandles,
} from "../../../src/extensions/multi-agent.ts";

type ChildAgentSession = Awaited<ReturnType<ChildAgentSessionFactory>>;

import { testProcessIdentity } from "../../helpers/process-identity.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

function deferred<T>() {
	let resolve: (value: T | PromiseLike<T>) => void = () => {};
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

async function eventually(predicate: () => boolean, description: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

interface SupervisorFixture {
	controlDbPath: string;
	harness: Harness;
	runtimeHandles: ReturnType<typeof createMultiAgentRuntimeHandles>;
	store: MultiAgentStore;
}

const harnesses: Harness[] = [];
const retainedTempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		harnesses.map(async (harness) => {
			await harness.session.agent.waitForIdle();
			await harness.session.drainRuntimeCoordination();
		}),
	);
	while (harnesses.length > 0) {
		const harness = harnesses.pop();
		if (!harness) continue;
		retainedTempDirs.push(harness.tempDir);
		harness.session.dispose();
	}
});

afterAll(() => {
	for (const tempDir of retainedTempDirs) {
		rmSync(tempDir, { force: true, recursive: true });
	}
});

async function createSupervisorFixture(
	options: {
		bindExtensions?: boolean;
		createAttachedSession?: AttachedSessionFactory;
		createChildSession?: ChildAgentSessionFactory;
	} = {},
): Promise<SupervisorFixture> {
	const store = new MultiAgentStore({ now: () => "2026-07-12T00:00:00.000Z" });
	const runtimeHandles = createMultiAgentRuntimeHandles();
	const harness = await createHarness({
		extensionFactories: [
			(pi) =>
				multiAgentExtension(pi, {
					createAttachedSession: options.createAttachedSession,
					createChildSession: options.createChildSession,
					runtimeHandles,
					store,
				}),
		],
		multiAgentStore: store,
		persistedSession: true,
	});
	harnesses.push(harness);
	const controlDbPath = getControlDbPath(harness.tempDir);
	harness.sessionManager.setMetadataControlDbPath(controlDbPath);
	store.setPersistenceSessionManager(harness.sessionManager);
	if (options.bindExtensions ?? true) await harness.session.bindExtensions({ controlDbPath });
	return { controlDbPath, harness, runtimeHandles, store };
}

async function createFauxChildSession(
	fixture: SupervisorFixture,
	input: Parameters<ChildAgentSessionFactory>[0],
	configure: (harness: Harness) => void,
): Promise<ChildAgentSession> {
	const child = await createHarness({
		multiAgentAgentId: input.agent.id,
		multiAgentParentSessionId: fixture.harness.sessionManager.getSessionId(),
		multiAgentStore: fixture.store,
		persistedSession: true,
	});
	harnesses.push(child);
	child.sessionManager.setMetadataControlDbPath(fixture.controlDbPath);
	await child.session.bindExtensions({ controlDbPath: fixture.controlDbPath });
	configure(child);
	return {
		abort: () => {
			void child.session.abort();
		},
		dispose: () => child.session.dispose(),
		drainRuntimeCoordination: () => child.session.drainRuntimeCoordination(),
		messages: child.session.messages,
		prompt: async (text) => {
			await child.session.prompt(text);
		},
		transcript: {
			path: child.sessionManager.getSessionFile(),
			sessionId: child.sessionManager.getSessionId(),
		},
	};
}

function latestToolResult(harness: Harness, toolName: string) {
	const events = harness.eventsOfType("tool_execution_end").filter((event) => event.toolName === toolName);
	return events.at(-1)?.result;
}

describe("approved multi-agent lifecycle e2e", () => {
	it("persists a spawned agent as running only after child construction succeeds", async () => {
		const factoryStarted = deferred<void>();
		const releaseFactory = deferred<void>();
		const releasePrompt = deferred<void>();
		let fixture!: SupervisorFixture;
		const createChildSession: ChildAgentSessionFactory = async (input) => {
			factoryStarted.resolve();
			await releaseFactory.promise;
			return createFauxChildSession(fixture, input, (child) => {
				child.setResponses([
					async () => {
						await releasePrompt.promise;
						return fauxAssistantMessage("child complete");
					},
				]);
			});
		};
		fixture = await createSupervisorFixture({ createChildSession });
		fixture.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("spawn_agent", { displayName: "Worker", prompt: "do work" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("spawn requested"),
		]);

		const parentPrompt = fixture.harness.session.prompt("start worker");
		await factoryStarted.promise;
		expect(fixture.store.listAgents()).toEqual([]);

		releaseFactory.resolve();
		await eventually(() => fixture.store.listAgents()[0]?.lifecycle === "running", "spawned agent to run");
		expect(fixture.store.listAgents()[0]).toMatchObject({ lifecycle: "running", revision: 1 });
		releasePrompt.resolve();
		await parentPrompt;
	});

	it("delivers steering while running before the child reaches terminal state", async () => {
		const childStarted = deferred<void>();
		const releaseChildResponse = deferred<void>();
		let childHarness!: Harness;
		let fixture!: SupervisorFixture;
		const createChildSession: ChildAgentSessionFactory = async (input) =>
			createFauxChildSession(fixture, input, (child) => {
				childHarness = child;
				child.setResponses([
					async () => {
						childStarted.resolve();
						await releaseChildResponse.promise;
						return fauxAssistantMessage("initial work complete");
					},
					fauxAssistantMessage("steering applied"),
				]);
			});
		fixture = await createSupervisorFixture({ createChildSession });
		fixture.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("spawn_agent", { displayName: "Worker", prompt: "initial work" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("spawned"),
		]);
		await fixture.harness.session.prompt("spawn worker");
		await childStarted.promise;
		const agent = fixture.store.listAgents()[0];
		if (!agent) throw new Error("expected spawned agent");

		fixture.harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("steer_agent", {
					agentId: agent.id,
					expectedRevision: agent.revision,
					message: "also check the edge case",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("steering queued"),
		]);
		await fixture.harness.session.prompt("steer worker");
		expect(fixture.store.getAgent(agent.id)).toMatchObject({ lifecycle: "steering_pending" });

		releaseChildResponse.resolve();
		await eventually(() => fixture.store.getAgent(agent.id)?.lifecycle === "completed", "steered agent to complete");
		await childHarness.session.agent.waitForIdle();
		await childHarness.session.drainRuntimeCoordination();
		await fixture.harness.session.agent.waitForIdle();
		await fixture.harness.session.drainRuntimeCoordination();
		expect(fixture.store.listMailboxMessages()).toEqual(
			expect.arrayContaining([expect.objectContaining({ body: "also check the edge case", status: "delivered" })]),
		);
		expect(getUserTexts({ session: childHarness.session } as Harness)).toEqual(
			expect.arrayContaining([expect.stringContaining("also check the edge case")]),
		);
	});

	it("returns one pending completion from wait_agents, then no active agents", async () => {
		const childStarted = deferred<void>();
		const releaseChildResponse = deferred<void>();
		let fixture!: SupervisorFixture;
		const createChildSession: ChildAgentSessionFactory = async (input) =>
			createFauxChildSession(fixture, input, (child) => {
				child.setResponses([
					async () => {
						childStarted.resolve();
						await releaseChildResponse.promise;
						return fauxAssistantMessage("finished");
					},
				]);
			});
		fixture = await createSupervisorFixture({ createChildSession });
		fixture.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("spawn_agent", { displayName: "Worker", prompt: "finish work" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("spawned"),
		]);
		await fixture.harness.session.prompt("spawn worker");
		await childStarted.promise;

		fixture.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait_agents", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("wait returned"),
		]);
		const waitPrompt = fixture.harness.session.prompt("wait");
		await eventually(
			() => fixture.harness.eventsOfType("tool_execution_start").some((event) => event.toolName === "wait_agents"),
			"wait_agents to start",
		);
		releaseChildResponse.resolve();
		await waitPrompt;
		const firstWait = latestToolResult(fixture.harness, "wait_agents");
		expect(firstWait?.content).toEqual([expect.objectContaining({ type: "text" })]);
		expect(firstWait?.details).toMatchObject({ message: { status: "pending" } });

		fixture.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait_agents", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("nothing else running"),
		]);
		await fixture.harness.session.prompt("wait again");
		const waitResults = fixture.harness
			.eventsOfType("tool_execution_end")
			.filter((event) => event.toolName === "wait_agents")
			.map((event) => event.result);
		expect(waitResults).toHaveLength(2);
		expect(waitResults[1]).toEqual({ content: [], details: {} });
	});

	it("reaches aborted only after cancellation acknowledgement", async () => {
		const childStarted = deferred<void>();
		const releaseChildResponse = deferred<void>();
		const abortChildResponse = deferred<void>();
		let fixture!: SupervisorFixture;
		const createChildSession: ChildAgentSessionFactory = async (input) => {
			input.signal?.addEventListener("abort", () => abortChildResponse.resolve(), { once: true });
			return createFauxChildSession(fixture, input, (child) => {
				child.setResponses([
					async () => {
						childStarted.resolve();
						await Promise.race([releaseChildResponse.promise, abortChildResponse.promise]);
						return fauxAssistantMessage("should not finish naturally");
					},
				]);
			});
		};
		fixture = await createSupervisorFixture({ createChildSession });
		fixture.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("spawn_agent", { displayName: "Worker", prompt: "wait" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("spawned"),
		]);
		await fixture.harness.session.prompt("spawn worker");
		await childStarted.promise;
		const agent = fixture.store.listAgents()[0];
		if (!agent) throw new Error("expected spawned agent");

		fixture.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("cancel_agent", { agentId: agent.id, reason: "stop" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("cancel requested"),
		]);
		await fixture.harness.session.prompt("cancel worker");

		expect(fixture.store.getAgent(agent.id)).toMatchObject({ lifecycle: "cancelling" });
		releaseChildResponse.resolve();
		await eventually(() => fixture.store.getAgent(agent.id)?.lifecycle === "aborted", "cancellation acknowledgement");
		expect(fixture.store.getAgent(agent.id)).toMatchObject({ lifecycle: "aborted" });
		expect(latestToolResult(fixture.harness, "cancel_agent")?.content).toEqual([
			{ text: "Cancellation requested for Worker.", type: "text" },
		]);
	});

	it("resumes persisted running work with no local runtime on session_start", async () => {
		const prompts: string[] = [];
		const createAttachedSession: AttachedSessionFactory = async ({ agent, sessionPath }) => ({
			messages: [fauxAssistantMessage("resumed complete")],
			prompt: async (prompt) => {
				prompts.push(prompt);
			},
			transcript: agent.transcript ?? { path: sessionPath, sessionId: "missing-runtime-session" },
		});
		const fixture = await createSupervisorFixture({ bindExtensions: false, createAttachedSession });
		const persistence = fixture.store.getPersistenceTarget();
		if (!persistence) throw new Error("expected persisted supervisor session");
		const coordinator = new LifecycleCoordinator({
			controlDbPath: persistence.controlDbPath,
			createAgentId: () => fixture.store.allocateAgentIdForLifecycleCoordinator(),
			now: () => "2026-07-12T00:00:00.000Z",
			processIdentity: testProcessIdentity("missing-local-runtime"),
			sessionPath: persistence.sessionPath,
		});
		const prepared = coordinator.prepareChild({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Recovered worker",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/recovered.jsonl", sessionId: "missing-runtime-session" },
		});
		const created = coordinator.commitRunningChild(prepared, persistence.sessionPath);
		expect(created.ok).toBe(true);
		if (!created.ok) throw new Error("expected persisted running agent");
		fixture.store.publishLifecycleCoordinatorSnapshot(created.agent);
		fixture.store.restoreFromSessionManager(fixture.harness.sessionManager);
		expect(fixture.runtimeHandles.sessions).toEqual(new Map());
		expect(fixture.store.getAgent(created.agent.id)).toMatchObject({ lifecycle: "running" });

		await fixture.harness.session.bindExtensions({ controlDbPath: fixture.controlDbPath });
		await eventually(
			() => fixture.store.getAgent(created.agent.id)?.lifecycle === "completed",
			"persisted running agent to resume",
		);
		expect(prompts).toEqual([expect.stringContaining("Continue the conversation")]);
	});
});
