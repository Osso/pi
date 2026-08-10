import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerAgentsCoreTools } from "../extensions/agents-core/src/runtime.ts";
import { createDetachedJobLifecycleController } from "../src/core/detached-job-lifecycle.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import {
	type BashBackgroundJobsOptions,
	BashToolDetachRegistry,
	createBashToolDefinition,
} from "../src/core/tools/bash.ts";
import { testProcessIdentity } from "./helpers/process-identity.ts";

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
	for (let attempt = 0; attempt < 300; attempt += 1) {
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

function createBackgroundJobs(root: string, store: MultiAgentStore): BashBackgroundJobsOptions {
	const controlDbPath = join(root, "control.sqlite");
	const sessionPath = join(root, "session.jsonl");
	store.setPersistenceSessionManager({
		getMetadataControlDbPath: () => controlDbPath,
		getSessionFile: () => sessionPath,
	} as never);
	const coordinator = new LifecycleCoordinator({
		controlDbPath,
		createAgentId: () => store.allocateAgentIdForLifecycleCoordinator(),
		now: () => new Date().toISOString(),
		processIdentity: testProcessIdentity("bash-test-runtime"),
		sessionPath,
	});
	return {
		lifecycle: createDetachedJobLifecycleController({
			artifactRoot: root,
			controlDbPath,
			coordinator,
			ownerSessionId: "bash-test-session",
			sessionPath,
			store,
		}),
		store,
	};
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
	const tool = tools.get("close_agent");
	if (!tool) throw new Error("close_agent was not registered");
	return tool;
}

describe("bash tool background detach", () => {
	it("keeps a fast Bash command foreground without creating a background job", async () => {
		const cwd = await createTempDir();
		const store = new MultiAgentStore();
		const detachRegistry = new BashToolDetachRegistry({ autoDetachAfterMs: 1_000 });
		const backgroundJobs = createBackgroundJobs(cwd, store);
		const tool = createBashToolDefinition(cwd, { backgroundJobs, detachRegistry });

		const result = await tool.execute(
			"tool-bash-foreground",
			{ command: `${quotePath(process.execPath)} -e ${quotePath("console.log('foreground')")}` },
			undefined,
			undefined,
			{} as never,
		);

		const resultText = textFrom(result);
		expect(resultText).toContain("foreground");
		expect(resultText).not.toContain("Command moved to background");
		expect(store.listAgents()).toHaveLength(0);
	});

	it("detaches a running bash tool into the multi-agent job store and moves later output to a log file", async () => {
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
		const backgroundJobs = createBackgroundJobs(cwd, store);
		const tool = createBashToolDefinition(cwd, { backgroundJobs, detachRegistry });

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
		expect(job.worker?.toolCallId).toBe("tool-bash-detach");

		await waitFor(() => {
			backgroundJobs.lifecycle?.observe(job.id);
			return store.getAgent(job.id)?.lifecycle === "completed";
		}, "detached process completion");
		const completed = store.getAgent(job.id);
		expect(completed?.result?.summary).toBe("Process exited successfully.");

		const [fileRef] = completed?.result?.fileRefs ?? [];
		expect(fileRef).toMatchObject({ label: "Bash output" });
		expect(fileRef?.path && existsSync(fileRef.path)).toBe(true);
		expect(fileRef?.path ? readFileSync(fileRef.path, "utf8") : "").toContain("after-detach");
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
		const backgroundJobs = createBackgroundJobs(cwd, store);
		const tool = createBashToolDefinition(cwd, { backgroundJobs, detachRegistry });

		const resultPromise = tool.execute(
			"tool-bash-auto-detach",
			{ command: `${quotePath(process.execPath)} ${quotePath(scriptPath)}` },
			undefined,
			(partial) => updates.push(textFrom(partial)),
			{} as never,
		);
		const result = await resultPromise;
		const resultText = textFrom(result);
		expect(resultText).toContain("Command moved to background as job");
		expect(resultText).not.toContain("after-auto-detach");

		const [job] = store.listAgents();
		expect(job).toMatchObject({ agentType: "background", displayName: "Bash command", lifecycle: "running" });
		await waitFor(() => {
			backgroundJobs.lifecycle?.observe(job.id);
			return store.getAgent(job.id)?.lifecycle === "completed";
		}, "auto-detached process completion");
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
		const backgroundJobs = createBackgroundJobs(cwd, store);
		const tool = createBashToolDefinition(cwd, { backgroundJobs, detachRegistry });

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
		await waitFor(() => {
			backgroundJobs.lifecycle?.observe(job.id);
			return store.getAgent(job.id)?.lifecycle === "failed";
		}, "detached timeout failure");
		expect(store.getAgent(job.id)?.result?.summary).toBe("Detached Bash command timed out");
	});

	it("restores an unfinished Bash call onto its live detached runner", async () => {
		const cwd = await createTempDir();
		const attemptsPath = join(cwd, "attempts.log");
		const releasePath = join(cwd, "release");
		const scriptPath = join(cwd, "restore-live-runner.mjs");
		writeFileSync(
			scriptPath,
			[
				"import { appendFileSync, existsSync } from 'node:fs';",
				`const attemptsPath = ${JSON.stringify(attemptsPath)};`,
				`const releasePath = ${JSON.stringify(releasePath)};`,
				"appendFileSync(attemptsPath, 'attempt\\n');",
				"const timer = setInterval(() => {",
				"  if (!existsSync(releasePath)) return;",
				"  console.log('restored output');",
				"  clearInterval(timer);",
				"  process.exit(0);",
				"}, 10);",
			].join("\n"),
		);

		const toolCallId = "tool-bash-restore-live";
		const originalStore = new MultiAgentStore();
		const originalDetachRegistry = new BashToolDetachRegistry();
		const originalBackgroundJobs = createBackgroundJobs(cwd, originalStore);
		const originalTool = createBashToolDefinition(cwd, {
			backgroundJobs: originalBackgroundJobs,
			detachRegistry: originalDetachRegistry,
		});
		const command = `${quotePath(process.execPath)} ${quotePath(scriptPath)}`;
		const originalResultPromise = originalTool.execute(toolCallId, { command }, undefined, undefined, {} as never);

		await waitFor(() => existsSync(attemptsPath), "initial Bash command attempt");
		expect(originalDetachRegistry.detachRunning()).toBe(true);
		const originalResult = await originalResultPromise;
		expect(textFrom(originalResult)).toContain("Detached bash command as background job");
		const [originalJob] = originalStore.listAgents();
		expect(originalJob?.worker?.toolCallId).toBe(toolCallId);
		expect(originalJob?.lifecycle).toBe("running");

		const restoredStore = new MultiAgentStore();
		const restoredBackgroundJobs = createBackgroundJobs(cwd, restoredStore);
		const restoredTool = createBashToolDefinition(cwd, {
			backgroundJobs: restoredBackgroundJobs,
			detachRegistry: new BashToolDetachRegistry(),
		});
		expect(restoredBackgroundJobs.lifecycle?.findBashJobByToolCallId(toolCallId)).toMatchObject({
			lifecycle: "running",
		});

		const restoredResultPromise = restoredTool.execute(toolCallId, { command }, undefined, undefined, {} as never);
		try {
			await delay(0);
			expect(readdirSync(join(cwd, "detached-jobs", "session"))).toHaveLength(1);
			expect(readFileSync(attemptsPath, "utf8").trim().split("\n")).toEqual(["attempt"]);
		} finally {
			writeFileSync(releasePath, "release\n");
			await Promise.allSettled([originalResultPromise, restoredResultPromise]);
		}

		const restoredResult = await restoredResultPromise;
		expect(textFrom(restoredResult)).toContain("restored output");
		await waitFor(() => {
			originalBackgroundJobs.lifecycle?.observe(originalJob.id);
			return originalStore.getAgent(originalJob.id)?.lifecycle === "completed";
		}, "original detached runner completion");
	});

	it("replays a completed detached Bash result without rerunning the same tool call", async () => {
		const cwd = await createTempDir();
		const attemptsPath = join(cwd, "attempts.log");
		const releasePath = join(cwd, "release");
		const scriptPath = join(cwd, "restore-completed-runner.mjs");
		writeFileSync(
			scriptPath,
			[
				"import { appendFileSync, existsSync } from 'node:fs';",
				`appendFileSync(${JSON.stringify(attemptsPath)}, 'attempt\\n');`,
				`const releasePath = ${JSON.stringify(releasePath)};`,
				"const timer = setInterval(() => {",
				"  if (!existsSync(releasePath)) return;",
				"  console.log('persisted completed output');",
				"  clearInterval(timer);",
				"  process.exit(0);",
				"}, 10);",
			].join("\n"),
		);

		const toolCallId = "tool-bash-restore-completed";
		const originalStore = new MultiAgentStore();
		const originalDetachRegistry = new BashToolDetachRegistry();
		const originalBackgroundJobs = createBackgroundJobs(cwd, originalStore);
		const originalTool = createBashToolDefinition(cwd, {
			backgroundJobs: originalBackgroundJobs,
			detachRegistry: originalDetachRegistry,
		});
		const command = `${quotePath(process.execPath)} ${quotePath(scriptPath)}`;
		const originalResultPromise = originalTool.execute(toolCallId, { command }, undefined, undefined, {} as never);

		await waitFor(() => existsSync(attemptsPath), "completed Bash command attempt");
		expect(originalDetachRegistry.detachRunning()).toBe(true);
		const originalResult = await originalResultPromise;
		expect(textFrom(originalResult)).toContain("Detached bash command as background job");
		const [originalJob] = originalStore.listAgents();
		if (!originalJob) throw new Error("Missing completed detached Bash job");
		writeFileSync(releasePath, "release\n");
		await waitFor(() => {
			originalBackgroundJobs.lifecycle?.observe(originalJob.id);
			return originalStore.getAgent(originalJob.id)?.lifecycle === "completed";
		}, "completed detached Bash job");

		const restoredStore = new MultiAgentStore();
		const restoredBackgroundJobs = createBackgroundJobs(cwd, restoredStore);
		const restoredTool = createBashToolDefinition(cwd, {
			backgroundJobs: restoredBackgroundJobs,
			detachRegistry: new BashToolDetachRegistry(),
		});
		const restoredResult = await restoredTool.execute(toolCallId, { command }, undefined, undefined, {} as never);

		expect(textFrom(restoredResult)).toContain("persisted completed output");
		expect(readFileSync(attemptsPath, "utf8").trim().split("\n")).toEqual(["attempt"]);
		expect(readdirSync(join(cwd, "detached-jobs", "session"))).toHaveLength(1);
	});

	it("restores an aborted detached Bash job without rerunning the same tool call", async () => {
		const cwd = await createTempDir();
		const attemptsPath = join(cwd, "attempts.log");
		const scriptPath = join(cwd, "restore-aborted-runner.mjs");
		writeFileSync(
			scriptPath,
			[
				"import { appendFileSync } from 'node:fs';",
				`appendFileSync(${JSON.stringify(attemptsPath)}, 'attempt\\n');`,
				"console.log('persisted aborted output');",
				"setInterval(() => {}, 20);",
			].join("\n"),
		);

		const toolCallId = "tool-bash-restore-aborted";
		const originalStore = new MultiAgentStore();
		const originalDetachRegistry = new BashToolDetachRegistry();
		const originalBackgroundJobs = createBackgroundJobs(cwd, originalStore);
		const originalTool = createBashToolDefinition(cwd, {
			backgroundJobs: originalBackgroundJobs,
			detachRegistry: originalDetachRegistry,
		});
		const command = `${quotePath(process.execPath)} ${quotePath(scriptPath)}`;
		const originalResultPromise = originalTool.execute(toolCallId, { command }, undefined, undefined, {} as never);

		await waitFor(() => existsSync(attemptsPath), "aborted Bash command attempt");
		expect(originalDetachRegistry.detachRunning()).toBe(true);
		const originalResult = await originalResultPromise;
		expect(textFrom(originalResult)).toContain("Detached bash command as background job");
		const [originalJob] = originalStore.listAgents();
		if (!originalJob) throw new Error("Missing aborted detached Bash job");

		const cancelAgent = registerCancelAgentTool(originalStore);
		await cancelAgent.execute(
			"cancel-restored-aborted-bash",
			{ agentId: originalJob.id, reason: "test" },
			undefined,
			undefined,
			{ cwd, hasUI: false, mode: "print" } as ExtensionContext,
		);
		const pid = Number(originalJob.worker?.handleId);
		if (!Number.isInteger(pid)) throw new Error("Aborted detached Bash job has no runner PID");
		await waitFor(() => !isProcessAlive(pid), "aborted detached Bash process");
		await waitFor(() => {
			originalBackgroundJobs.lifecycle?.observe(originalJob.id);
			return originalStore.getAgent(originalJob.id)?.lifecycle === "aborted";
		}, "aborted detached Bash job");

		const restoredStore = new MultiAgentStore();
		const restoredBackgroundJobs = createBackgroundJobs(cwd, restoredStore);
		const restoredTool = createBashToolDefinition(cwd, {
			backgroundJobs: restoredBackgroundJobs,
			detachRegistry: new BashToolDetachRegistry(),
		});
		await expect(restoredTool.execute(toolCallId, { command }, undefined, undefined, {} as never)).rejects.toThrow(
			"Command aborted",
		);

		expect(readFileSync(attemptsPath, "utf8").trim().split("\n")).toEqual(["attempt"]);
		expect(readdirSync(join(cwd, "detached-jobs", "session"))).toHaveLength(1);
	});

	it("routes close_agent through detached Bash runtime mailbox control", async () => {
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
		const backgroundJobs = createBackgroundJobs(cwd, store);
		const tool = createBashToolDefinition(cwd, { backgroundJobs, detachRegistry });
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
			{ agentId: job.id, reason: "test" },
			undefined,
			undefined,
			{ cwd, hasUI: false, mode: "print" } as ExtensionContext,
		);
		expect((cancelled as AgentToolResult<CancelAgentDetails>).details.agent.lifecycle).toBe("cancelling");
		expect(textFrom(cancelled)).toContain("Cancellation requested");
		await waitFor(() => !isProcessAlive(pid), "detached process termination");
		await waitFor(() => {
			backgroundJobs.lifecycle?.observe(job.id);
			return (store.getAgent(job.id)?.result?.fileRefs?.length ?? 0) === 1;
		}, "terminated process log");
		const [fileRef] = store.getAgent(job.id)?.result?.fileRefs ?? [];
		expect(fileRef).toMatchObject({ label: "Bash output" });
		expect(fileRef?.path && existsSync(fileRef.path)).toBe(true);
	});
});
