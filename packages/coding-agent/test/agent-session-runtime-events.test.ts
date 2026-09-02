import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { archivePersistedSession } from "../src/core/session-archive-storage.ts";
import { getControlDbPath, readSessionMetadata } from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type {
	ExtensionContext,
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../src/index.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

const sessionTimerIntervalMs = 1;
const staleTimerObservationMs = 10;

type Deferred = { promise: Promise<void>; resolve(): void };

interface ConcurrentLifecycleProbe {
	startedSessionIds: string[];
	shutdownSessionIds: string[];
	staleTimerSessionIds: string[];
	shutdownEntered: Deferred[];
	shutdownRelease: Deferred[];
	timers: Map<string, ReturnType<typeof setInterval>>;
}

function createDeferred(): Deferred {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: () => {
			if (!resolvePromise) throw new Error("Deferred promise was not initialized");
			resolvePromise();
		},
	};
}

function createConcurrentLifecycleProbe(): ConcurrentLifecycleProbe {
	return {
		startedSessionIds: [],
		shutdownSessionIds: [],
		staleTimerSessionIds: [],
		shutdownEntered: [createDeferred(), createDeferred()],
		shutdownRelease: [createDeferred(), createDeferred()],
		timers: new Map(),
	};
}

function isSessionContextStale(ctx: ExtensionContext): boolean {
	try {
		ctx.sessionManager.getSessionId();
		return false;
	} catch {
		return true;
	}
}

function stopSessionTimer(probe: ConcurrentLifecycleProbe, sessionId: string): void {
	const timer = probe.timers.get(sessionId);
	if (!timer) return;
	clearInterval(timer);
	probe.timers.delete(sessionId);
}

function observeSessionContext(probe: ConcurrentLifecycleProbe, ctx: ExtensionContext, sessionId: string): void {
	if (!isSessionContextStale(ctx)) return;
	probe.staleTimerSessionIds.push(sessionId);
	stopSessionTimer(probe, sessionId);
}

function startSessionTimer(probe: ConcurrentLifecycleProbe, ctx: ExtensionContext): void {
	const sessionId = ctx.sessionManager.getSessionId();
	probe.startedSessionIds.push(sessionId);
	probe.timers.set(
		sessionId,
		setInterval(() => observeSessionContext(probe, ctx, sessionId), sessionTimerIntervalMs),
	);
}

async function recordSessionShutdown(probe: ConcurrentLifecycleProbe, ctx: ExtensionContext): Promise<void> {
	const sessionId = ctx.sessionManager.getSessionId();
	stopSessionTimer(probe, sessionId);
	const callIndex = probe.shutdownSessionIds.push(sessionId) - 1;
	probe.shutdownEntered[callIndex]?.resolve();
	await probe.shutdownRelease[callIndex]?.promise;
}

function createConcurrentLifecycleExtension(probe: ConcurrentLifecycleProbe): ExtensionFactory {
	return (pi) => {
		pi.on("session_start", (_event, ctx) => startSessionTimer(probe, ctx));
		pi.on("session_shutdown", (_event, ctx) => recordSessionShutdown(probe, ctx));
	};
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

async function createRuntimeHost(extensionFactory: ExtensionFactory) {
	const tempDir = join(tmpdir(), `pi-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

	const runtimeOptions = {
		agentDir: tempDir,
		authStorage,
		model: faux.getModel(),
		resourceLoaderOptions: {
			extensionFactories: [extensionFactory],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		},
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			...runtimeOptions,
			cwd,
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
	const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
	sessionManager.setMetadataControlDbPath(getControlDbPath(tempDir));
	const runtimeHost = await createAgentSessionRuntime(createRuntime, {
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager,
	});
	await runtimeHost.session.bindExtensions({});

	cleanups.push(async () => {
		await runtimeHost.dispose();
		faux.unregister();
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	return { runtimeHost, faux };
}

describe("AgentSessionRuntime session lifecycle events", () => {
	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;
		expect(originalSessionFile).toBeTruthy();

		const newSessionResult = await runtimeHost.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		const secondSessionFile = runtimeHost.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;
		expect(secondSessionFile).toBeTruthy();

		const switchResult = await runtimeHost.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("restores archive storage and metadata through the resume_session runtime path", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;
		if (!originalSessionFile) throw new Error("Expected persisted session");
		const controlDbPath = getControlDbPath(runtimeHost.services.agentDir);

		await runtimeHost.newSession();
		const archivedSessionFile = archivePersistedSession(controlDbPath, originalSessionFile);
		expect(readSessionMetadata(controlDbPath, archivedSessionFile)?.isArchived).toBe(true);

		await runtimeHost.switchSession(archivedSessionFile);

		expect(runtimeHost.session.sessionFile).toBe(originalSessionFile);
		expect(readSessionMetadata(controlDbPath, archivedSessionFile)).toBeUndefined();
		expect(readSessionMetadata(controlDbPath, originalSessionFile)?.isArchived).toBe(false);
	});

	it("honors session_before_switch cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				return { cancel: true };
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;

		const result = await runtimeHost.newSession();
		expect(result.cancelled).toBe(true);
		expect(runtimeHost.session.sessionFile).toBe(originalSessionFile);
		expect(events).toEqual([{ type: "session_before_switch", reason: "new", targetSessionFile: undefined }]);
	});

	it("runs beforeSessionInvalidate after session_shutdown and before rebindSession", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		runtimeHost.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		await runtimeHost.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "rebindSession"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setRebindSession(undefined);
	});
});

describe("AgentSessionRuntime concurrent lifecycle transitions", () => {
	it("serializes concurrent replacements so each session shuts down before invalidation", async () => {
		const probe = createConcurrentLifecycleProbe();
		const { runtimeHost } = await createRuntimeHost(createConcurrentLifecycleExtension(probe));
		runtimeHost.setRebindSession(async (session) => {
			await session.bindExtensions({});
		});

		const initialSessionId = runtimeHost.session.sessionId;
		const firstReplacement = runtimeHost.newSession();
		await probe.shutdownEntered[0].promise;

		const secondReplacement = runtimeHost.newSession();
		await new Promise<void>((resolve) => setImmediate(resolve));
		probe.shutdownRelease[0].resolve();
		await firstReplacement;

		const replacementSessionId = runtimeHost.session.sessionId;
		await probe.shutdownEntered[1].promise;
		probe.shutdownRelease[1].resolve();
		await secondReplacement;
		await delay(staleTimerObservationMs);

		expect(probe.startedSessionIds).toHaveLength(3);
		expect(probe.shutdownSessionIds.slice(0, 2)).toEqual([initialSessionId, replacementSessionId]);
		expect(probe.staleTimerSessionIds).toEqual([]);
	});
});

describe("AgentSessionRuntime fork lifecycle events", () => {
	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const userMessage = runtimeHost.session.getUserMessagesForForking()[0];
		const previousSessionFile = runtimeHost.session.sessionFile;

		const successResult = await runtimeHost.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtimeHost.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtimeHost.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtimeHost.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});
});
