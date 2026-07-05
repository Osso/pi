import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerAgentsCoreTools } from "../extensions/agents-core/src/runtime.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { BashToolDetachRegistry, createBashToolDefinition } from "../src/core/tools/bash.ts";

interface CancelAgentDetails extends Record<string, unknown> {
	agent: { id: string; lifecycle: string; revision: number };
	reason?: string;
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
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (condition()) return;
		await delay(10);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-bash-detach-test-"));
	tempDirs.push(dir);
	return dir;
}

function textFrom(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((item) => (item.type === "text" ? (item.text ?? "") : "")).join("\n");
}

function quotePath(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function registerCancelAgentTool(store: MultiAgentStore): RegisteredTool {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerCommand() {},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool as RegisteredTool);
		},
	} as unknown as ExtensionAPI;
	registerAgentsCoreTools(pi, { store });
	const tool = tools.get("cancel_agent");
	if (!tool) throw new Error("cancel_agent was not registered");
	return tool;
}

describe("bash tool background detach", () => {
	it("detaches a running bash tool into the multi-agent job store and moves later output to a log artifact", async () => {
		const cwd = await createTempDir();
		const scriptPath = join(cwd, "emit-after-detach.mjs");
		writeFileSync(
			scriptPath,
			[
				"console.log('before-detach');",
				"setTimeout(() => console.log('after-detach'), 60);",
				"setTimeout(() => process.exit(0), 100);",
			].join("\n"),
		);
		const store = new MultiAgentStore();
		const detachRegistry = new BashToolDetachRegistry();
		const updates: string[] = [];
		const tool = createBashToolDefinition(cwd, { backgroundJobs: { store }, detachRegistry });

		const resultPromise = tool.execute(
			"tool-bash-detach",
			{ command: `${quotePath(process.execPath)} ${quotePath(scriptPath)}` },
			undefined,
			(partial) => updates.push(textFrom(partial)),
			{} as never,
		);

		await waitFor(() => updates.some((update) => update.includes("before-detach")), "pre-detach output");
		expect(detachRegistry.detachRunning()).toBe(true);

		const result = await resultPromise;
		const resultText = textFrom(result);
		expect(resultText).toContain("before-detach");
		expect(resultText).toContain("Detached bash command as background job");
		expect(resultText).not.toContain("after-detach");

		const [job] = store.listAgents();
		expect(job).toMatchObject({ agentType: "background", displayName: "Bash command", lifecycle: "running" });

		await waitFor(() => store.getAgent(job.id)?.lifecycle === "completed", "detached process completion");
		const completed = store.getAgent(job.id);
		expect(completed?.result?.summary).toContain("exit code 0");

		const [artifact] = store.listArtifacts(job.id);
		expect(artifact).toMatchObject({ kind: "log", title: "Bash output" });
		expect(artifact.path && existsSync(artifact.path)).toBe(true);
		expect(readFileSync(artifact.path!, "utf8")).toContain("after-detach");
	});

	it("auto-detaches a running bash tool after the registry threshold", async () => {
		const cwd = await createTempDir();
		const scriptPath = join(cwd, "auto-detach.mjs");
		writeFileSync(
			scriptPath,
			[
				"console.log('before-auto-detach');",
				"setTimeout(() => console.log('after-auto-detach'), 140);",
				"setTimeout(() => process.exit(0), 170);",
			].join("\n"),
		);
		const store = new MultiAgentStore();
		const detachRegistry = new BashToolDetachRegistry({ autoDetachAfterMs: 100 });
		const updates: string[] = [];
		const tool = createBashToolDefinition(cwd, { backgroundJobs: { store }, detachRegistry });

		const resultPromise = tool.execute(
			"tool-bash-auto-detach",
			{ command: `${quotePath(process.execPath)} ${quotePath(scriptPath)}` },
			undefined,
			(partial) => updates.push(textFrom(partial)),
			{} as never,
		);
		await waitFor(() => updates.some((update) => update.includes("before-auto-detach")), "pre-auto-detach output");

		const result = await resultPromise;
		const resultText = textFrom(result);
		expect(resultText).toContain("before-auto-detach");
		expect(resultText).toContain("Command moved to background as job");
		expect(resultText).not.toContain("after-auto-detach");

		const [job] = store.listAgents();
		expect(job).toMatchObject({ agentType: "background", displayName: "Bash command", lifecycle: "running" });
		await waitFor(() => store.getAgent(job.id)?.lifecycle === "completed", "auto-detached process completion");
	});

	it("does not auto-detach bash when no background job store is available", async () => {
		const cwd = await createTempDir();
		const scriptPath = join(cwd, "no-store-auto-detach.mjs");
		writeFileSync(
			scriptPath,
			[
				"console.log('before-no-store-auto-detach');",
				"setTimeout(() => console.log('after-no-store-auto-detach'), 80);",
				"setTimeout(() => process.exit(0), 110);",
			].join("\n"),
		);
		const detachRegistry = new BashToolDetachRegistry({ autoDetachAfterMs: 40 });
		const tool = createBashToolDefinition(cwd, { detachRegistry });

		const result = await tool.execute(
			"tool-bash-no-store-auto-detach",
			{ command: `${quotePath(process.execPath)} ${quotePath(scriptPath)}` },
			undefined,
			undefined,
			{} as never,
		);
		const resultText = textFrom(result);
		expect(resultText).toContain("before-no-store-auto-detach");
		expect(resultText).toContain("after-no-store-auto-detach");
		expect(resultText).not.toContain("Command moved to background");
		expect(result.details?.backgroundJobId).toBeUndefined();
	});

	it("keeps bash timeout active after detaching", async () => {
		const cwd = await createTempDir();
		const scriptPath = join(cwd, "timeout-running.mjs");
		writeFileSync(scriptPath, "setInterval(() => console.log('tick'), 20);\n");
		const store = new MultiAgentStore();
		const detachRegistry = new BashToolDetachRegistry();
		const updates: string[] = [];
		const tool = createBashToolDefinition(cwd, { backgroundJobs: { store }, detachRegistry });

		const resultPromise = tool.execute(
			"tool-bash-timeout",
			{ command: `${quotePath(process.execPath)} ${quotePath(scriptPath)}`, timeout: 0.5 },
			undefined,
			(partial) => updates.push(textFrom(partial)),
			{} as never,
		);
		await waitFor(() => updates.some((update) => update.includes("tick")), "pre-timeout output");
		expect(detachRegistry.detachRunning()).toBe(true);
		await resultPromise;

		const [job] = store.listAgents();
		await waitFor(() => store.getAgent(job.id)?.lifecycle === "failed", "detached timeout failure");
		expect(store.getAgent(job.id)?.result?.summary).toContain("exit code null");
	});

	it("lets cancel_agent kill a detached bash process tree", async () => {
		const cwd = await createTempDir();
		const markerPath = join(cwd, "still-running");
		const scriptPath = join(cwd, "long-running.mjs");
		writeFileSync(
			scriptPath,
			[
				"import { writeFileSync, rmSync } from 'node:fs';",
				`const marker = ${JSON.stringify(markerPath)};`,
				"writeFileSync(marker, 'running');",
				"process.on('SIGTERM', () => { rmSync(marker, { force: true }); process.exit(0); });",
				"setInterval(() => console.log('tick'), 20);",
			].join("\n"),
		);
		const store = new MultiAgentStore();
		const detachRegistry = new BashToolDetachRegistry();
		const tool = createBashToolDefinition(cwd, { backgroundJobs: { store }, detachRegistry });
		const cancelAgent = registerCancelAgentTool(store);

		const resultPromise = tool.execute(
			"tool-bash-cancel",
			{ command: `${quotePath(process.execPath)} ${quotePath(scriptPath)}` },
			undefined,
			undefined,
			{} as never,
		);
		await waitFor(() => existsSync(markerPath), "process marker");
		expect(detachRegistry.detachRunning()).toBe(true);
		await resultPromise;

		const [job] = store.listAgents();
		const pid = Number(job.worker?.handleId);
		expect(Number.isInteger(pid)).toBe(true);
		const cancelled = await cancelAgent.execute(
			"cancel-detached-bash",
			{ agentId: job.id, expectedRevision: job.revision, reason: "test" },
			undefined,
			undefined,
			{ cwd, hasUI: false, mode: "print" } as ExtensionContext,
		);
		expect((cancelled as AgentToolResult<CancelAgentDetails>).details.agent.lifecycle).toBe("aborted");
		await waitFor(() => !isProcessAlive(pid), "detached process termination");
		await waitFor(() => store.listArtifacts(job.id).length === 1, "cancelled process log artifact");
		const [artifact] = store.listArtifacts(job.id);
		expect(artifact).toMatchObject({ kind: "log", title: "Bash output" });
		expect(artifact.path && existsSync(artifact.path)).toBe(true);
	});
});
