import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import agentViewerExtension from "../extensions/agent-viewer/src/index.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import { type AgentSnapshot, MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { CURRENT_PROCESS_IDENTITY } from "./helpers/process-identity.ts";

interface AgentTraceEvent {
	agentId?: string;
	kind:
		| "agent_snapshot"
		| "child_end_turn"
		| "descendant_admitted"
		| "descendant_snapshot"
		| "parent_agent_complete"
		| "parent_agent_start"
		| "terminal_outbox";
	lifecycle?: AgentSnapshot["lifecycle"];
	timestamp: string;
	timestampSource:
		| "agent.updatedAt"
		| "descendant.createdAt"
		| "descendant.updatedAt"
		| "entry.timestamp"
		| "outbox.updated_at";
}

interface AgentViewerTraceDetails extends Record<string, unknown> {
	agent: AgentSnapshot;
	trace: {
		events: AgentTraceEvent[];
		ownership?: {
			agentId: string;
			owner: { agentId: string | null; sessionId?: string };
			processIdentity?: { pid: number; startTimeTicks: number };
			sessionPath: string;
		};
	};
}

type RegisteredTool = Omit<ToolDefinition, "execute"> & {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Record<string, unknown>>>;
};

const tempDirs: string[] = [];

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) {
		rmSync(tempDir, { force: true, recursive: true });
	}
});

function createTraceFixture(input: { completed: boolean }) {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-agent-viewer-trace-"));
	tempDirs.push(tempDir);
	const controlDbPath = join(tempDir, "control.sqlite");
	const supervisorSessionId = "01a00761-c710-7b26-a7d1-914e42b7b393";
	const viewerSessionId = "01a00761-c710-7b26-a7d1-914e42b7b394";
	const childSessionId = "01a007ee-4ea9-7375-925a-e6c55136d81a";
	const supervisorSession = SessionManager.create("/repo", tempDir, { id: supervisorSessionId });
	supervisorSession.setMetadataControlDbPath(controlDbPath);
	supervisorSession.persistForRecovery();
	const supervisorSessionPath = supervisorSession.getSessionFile();
	if (!supervisorSessionPath) throw new Error("expected persisted supervisor session");
	const viewerSession = SessionManager.create("/repo", tempDir, { id: viewerSessionId });
	viewerSession.setMetadataControlDbPath(controlDbPath);
	viewerSession.persistForRecovery();
	const childSessionPath = join(tempDir, `${childSessionId}.jsonl`);
	const timestamps = [
		"2026-08-15T23:59:58.000Z",
		"2026-08-15T23:59:59.000Z",
		"2026-08-16T00:00:00.000Z",
		"2026-08-16T00:00:00.100Z",
		"2026-08-16T00:00:02.000Z",
		"2026-08-16T00:00:03.000Z",
	];
	const terminalTimestamp = "2026-08-16T00:00:03.000Z";
	let timestampIndex = 0;
	const coordinator = new LifecycleCoordinator({
		controlDbPath,
		createAgentId: () => "agent_15",
		now: () => timestamps[timestampIndex++] ?? terminalTimestamp,
		processIdentity: CURRENT_PROCESS_IDENTITY,
		sessionPath: supervisorSessionPath,
	});
	const prepared = coordinator.prepareChild({
		agentType: "implement",
		cwd: "/repo",
		displayName: "Refactor shadowing tests",
		permission: { narrowed: true, policy: "on-request" },
		transcript: { path: childSessionPath, sessionId: childSessionId },
	});
	const running = coordinator.commitRunningChild(prepared, supervisorSessionId);
	if (!running.ok) throw new Error(`could not create running child: ${running.error}`);
	const preparedDescendant = coordinator.prepareChild({
		agentId: "detached_1",
		agentType: "background",
		cwd: "/repo",
		detached: true,
		displayName: "Pyrun evaluation",
		parentId: running.agent.id,
		permission: { narrowed: true, policy: "on-request" },
	});
	const runningDescendant = coordinator.commitRunningChild(
		preparedDescendant,
		childSessionId,
		CURRENT_PROCESS_IDENTITY,
		running.agent.id,
	);
	if (!runningDescendant.ok) throw new Error(`could not create running descendant: ${runningDescendant.error}`);
	if (input.completed) {
		const completedDescendant = coordinator.finalizeChild({
			agent: runningDescendant.agent,
			ownership: runningDescendant.ownership,
			result: { summary: "Detached work finished" },
			terminalLifecycle: "completed",
		});
		if (!completedDescendant.ok) {
			throw new Error(`could not finalize trace descendant: ${completedDescendant.error}`);
		}
	}
	const agent = input.completed
		? coordinator.finalizeChild({
				agent: running.agent,
				ownership: running.ownership,
				result: { summary: "Finished trace fixture" },
				terminalLifecycle: "completed",
			})
		: running;
	if (!agent.ok) throw new Error(`could not finalize trace fixture: ${agent.error}`);

	writeSessionEntries(supervisorSessionPath, [
		parentAgentEntry("parent-start", "2026-08-15T23:59:59.500Z", "agent_start", running.agent),
		...(input.completed
			? [parentAgentEntry("parent-complete", "2026-08-16T00:00:04.000Z", "agent_complete", agent.agent)]
			: []),
	]);
	writeChildEndTurn(childSessionPath, childSessionId);
	const currentStore = MultiAgentStore.fromSessionManager(viewerSession, {
		now: () => "2026-08-16T00:00:05.000Z",
	});
	return {
		agent: agent.agent,
		controlDbPath,
		currentStore,
		supervisorSessionId,
		viewerSession,
	};
}

function parentAgentEntry(
	id: string,
	timestamp: string,
	customType: "agent_complete" | "agent_start",
	agent: AgentSnapshot,
) {
	return {
		customType,
		data: {
			agentId: agent.id,
			childSessionId: agent.transcript?.sessionId,
			lifecycle: agent.lifecycle,
			transcriptPath: agent.transcript?.path,
		},
		id,
		parentId: null,
		timestamp,
		type: "custom",
	};
}

function writeSessionEntries(sessionPath: string, entries: unknown[]): void {
	const [headerLine] = readFileSync(sessionPath, "utf8").split("\n", 1);
	if (!headerLine) throw new Error(`session header is missing: ${sessionPath}`);
	const header = JSON.parse(headerLine);
	writeFileSync(sessionPath, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function writeChildEndTurn(childSessionPath: string, childSessionId: string): void {
	const header = {
		cwd: "/repo",
		id: childSessionId,
		timestamp: "2026-08-15T23:59:59.250Z",
		type: "session",
		version: 3,
	};
	const inheritedEndTurn = {
		id: "inherited-end-turn",
		message: {
			content: [{ text: "Turn ended: Parent history", type: "text" }],
			details: { reason: "Parent history" },
			isError: false,
			role: "toolResult",
			timestamp: Date.parse("2026-08-15T23:50:00.000Z"),
			toolCallId: "inherited-end-turn-call",
			toolName: "end_turn",
		},
		parentId: null,
		timestamp: "2026-08-15T23:50:00.000Z",
		type: "message",
	};
	const endTurn = {
		id: "child-end-turn",
		message: {
			content: [{ text: "Turn ended: Finished trace fixture", type: "text" }],
			details: { reason: "Finished trace fixture" },
			isError: false,
			role: "toolResult",
			timestamp: Date.parse("2026-08-16T00:00:01.000Z"),
			toolCallId: "end-turn-call",
			toolName: "end_turn",
		},
		parentId: null,
		timestamp: "2026-08-16T00:00:01.000Z",
		type: "message",
	};
	writeFileSync(
		childSessionPath,
		`${JSON.stringify(header)}\n${JSON.stringify(inheritedEndTurn)}\n${JSON.stringify(endTurn)}\n`,
	);
}

async function viewTrace(
	fixture: ReturnType<typeof createTraceFixture>,
): Promise<AgentToolResult<AgentViewerTraceDetails>> {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool as RegisteredTool);
		},
	} as unknown as ExtensionAPI;
	agentViewerExtension(pi, { store: fixture.currentStore });
	const tool = tools.get("agent_viewer");
	if (!tool) throw new Error("agent_viewer was not registered");
	const ctx = {
		controlDbPath: fixture.controlDbPath,
		cwd: "/repo",
		hasUI: false,
		mode: "print",
		sessionManager: fixture.viewerSession,
	} as unknown as ExtensionContext;
	return (await tool.execute(
		"agent-viewer-trace",
		{ agentId: fixture.agent.id, storeSessionId: fixture.supervisorSessionId, trace: true },
		undefined,
		undefined,
		ctx,
	)) as AgentToolResult<AgentViewerTraceDetails>;
}

function traceText(viewed: AgentToolResult<AgentViewerTraceDetails>): string {
	const content = viewed.content[0];
	if (!content || content.type !== "text") throw new Error("expected trace text content");
	return content.text;
}

describe("agent_viewer historical lifecycle trace", () => {
	it("shows the active descendant that keeps a child running after end_turn", async () => {
		const fixture = createTraceFixture({ completed: false });

		const viewed = await viewTrace(fixture);

		expect(viewed.details.trace.ownership).toMatchObject({
			agentId: fixture.agent.id,
			owner: { agentId: null, sessionId: fixture.supervisorSessionId },
			processIdentity: CURRENT_PROCESS_IDENTITY,
		});
		expect(viewed.details.trace.events.map((event) => event.kind)).toEqual([
			"agent_snapshot",
			"parent_agent_start",
			"descendant_admitted",
			"descendant_snapshot",
			"child_end_turn",
		]);
		expect(viewed.details.trace.events.map((event) => event.timestamp)).toEqual([
			"2026-08-15T23:59:58.000Z",
			"2026-08-15T23:59:59.500Z",
			"2026-08-16T00:00:00.000Z",
			"2026-08-16T00:00:00.000Z",
			"2026-08-16T00:00:01.000Z",
		]);
		expect(viewed.details.trace.events.map((event) => event.timestampSource)).toEqual([
			"agent.updatedAt",
			"entry.timestamp",
			"descendant.createdAt",
			"descendant.updatedAt",
			"entry.timestamp",
		]);
		expect(viewed.details.trace.events).toContainEqual(
			expect.objectContaining({
				agentId: "detached_1",
				kind: "descendant_snapshot",
				lifecycle: "running",
			}),
		);
		expect(traceText(viewed)).toContain(
			"descendant_snapshot agent=detached_1 parent=agent_15 lifecycle=running revision=1",
		);
	});

	it("shows descendant and parent terminal evidence in deterministic order", async () => {
		const fixture = createTraceFixture({ completed: true });

		const viewed = await viewTrace(fixture);

		expect(viewed.details.trace.ownership).toMatchObject({
			agentId: fixture.agent.id,
			owner: { agentId: null, sessionId: fixture.supervisorSessionId },
			processIdentity: CURRENT_PROCESS_IDENTITY,
		});
		expect(viewed.details.trace.events.map((event) => event.kind)).toEqual([
			"parent_agent_start",
			"descendant_admitted",
			"child_end_turn",
			"descendant_snapshot",
			"terminal_outbox",
			"agent_snapshot",
			"terminal_outbox",
			"parent_agent_complete",
		]);
		expect(viewed.details.trace.events.map((event) => event.timestamp)).toEqual([
			"2026-08-15T23:59:59.500Z",
			"2026-08-16T00:00:00.000Z",
			"2026-08-16T00:00:01.000Z",
			"2026-08-16T00:00:02.000Z",
			"2026-08-16T00:00:02.000Z",
			"2026-08-16T00:00:03.000Z",
			"2026-08-16T00:00:03.000Z",
			"2026-08-16T00:00:04.000Z",
		]);
		expect(viewed.details.trace.events.map((event) => event.timestampSource)).toEqual([
			"entry.timestamp",
			"descendant.createdAt",
			"entry.timestamp",
			"descendant.updatedAt",
			"outbox.updated_at",
			"agent.updatedAt",
			"outbox.updated_at",
			"entry.timestamp",
		]);
		expect(traceText(viewed)).toContain("terminal_outbox agent=detached_1 event=completed revision=2 status=pending");
	});
});
