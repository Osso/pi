import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMultiAgentPiRequestHandler,
	createProductionChildAgentSessionFactory,
	type ParentAgentJournalWriter,
} from "../extensions/agents-core/src/runtime.ts";
import { createPyrunEvalExecutor, formatCanonicalPyrunEvalResult } from "../extensions/pyrun/src/eval-tool.ts";
import pyrunExtension, { type PyrunExtensionOptions } from "../extensions/pyrun/src/index.ts";
import { PyrunRunnerClient, resolvePyrunRunnerOptions } from "../extensions/pyrun/src/runner.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import {
	getControlDbPath,
	readMultiAgentAgent,
	readMultiAgentRuntimeOwnership,
} from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { deliverTerminalOutboxProjections } from "../src/core/terminal-outbox-delivery.ts";
import { ToolDetachRegistry } from "../src/core/tool-detach-registry.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { writeFakeBwrap } from "./helpers/fake-bwrap.ts";
import { legacyMultiAgentStore } from "./helpers/legacy-multi-agent-store.ts";
import { testProcessIdentity } from "./helpers/process-identity.ts";
import { createHarness } from "./suite/harness.ts";

interface PyrunEvalParams {
	code: string;
	session_id?: string;
}

interface PyrunPiCapabilitySnapshot {
	footer: {
		availableProviderCount: number;
		branch: string | null;
		contextUsage:
			| {
					contextWindow: number;
					percent: number | null;
					tokens: number | null;
			  }
			| undefined;
		cwd: string;
		extensionStatuses: Record<string, string>;
		model: string | null;
		sessionName: string | null;
	};
}

interface PyrunEvalDetails {
	backgroundJobId?: string;
	approval?: {
		args: unknown;
		id: string;
		summary: string;
		tool: string;
	};
	console?: Array<string | { level: string; message: string }>;
	error?: string;
	executed?: string;
	type: "completed" | "detached" | "error" | "needs_approval";
	value?: unknown;
}

interface PyrunProgressDetails {
	executed?: string;
	message?: string;
	text?: string;
	type: string;
}

type PyrunHarnessOptions = PyrunExtensionOptions & {
	callCommand?: ExtensionAPI["callCommand"];
	callTool?: ExtensionAPI["callTool"];
	setModel?: ExtensionAPI["setModel"];
};

const temporaryHarnessDirectories: string[] = [];

type PyrunTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: PyrunEvalParams,
		signal: AbortSignal | undefined,
		onUpdate: ((result: AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<PyrunEvalDetails>>;
};

function createPyrunHarness(options: PyrunHarnessOptions = {}) {
	persistBackgroundStore(options.backgroundJobs?.store);
	let pyrunTool: PyrunTool | undefined;
	let pyrunDefinition: ToolDefinition | undefined;
	const compactRequests: unknown[] = [];
	const enqueuedMessages: Array<{ content: unknown; options: unknown }> = [];
	const restartRequests: unknown[] = [];
	const selectedModels: unknown[] = [];
	const switchedSessions: string[] = [];
	let sessionShutdownHandler: (() => void | Promise<void>) | undefined;

	const pi = {
		on(event: string, handler: () => void | Promise<void>) {
			if (event === "session_shutdown") sessionShutdownHandler = handler;
		},
		callCommand: options.callCommand ?? (async () => undefined),
		callTool: options.callTool ?? (async () => ({ content: [], details: undefined })),
		getCommands: () => [{ name: "usage", source: "extension" }],
		setModel:
			options.setModel ??
			(async (model: unknown) => {
				selectedModels.push(model);
				return true;
			}),
		setThinkingLevel: () => {},
		registerTool(tool: ToolDefinition) {
			if (tool.name === "pyrun_eval") {
				pyrunDefinition = tool;
				pyrunTool = tool as unknown as PyrunTool;
			}
		},
		sendUserMessage(content: unknown, messageOptions: unknown) {
			enqueuedMessages.push({ content, options: messageOptions });
		},
	} as unknown as ExtensionAPI;

	pyrunExtension(pi, options);

	if (!pyrunTool) {
		throw new Error("pyrun_eval was not registered");
	}

	const registeredPyrunTool = pyrunTool;
	const ctx = {
		cwd: process.cwd(),
		toolExecutionStartedAt: Date.now(),
		footerData: {
			getAvailableProviderCount: () => 3,
			getExecutableName: () => undefined,
			getExtensionStatuses: () =>
				new Map([
					["pyrun", "ready"],
					["agent", "idle"],
				]),
			getGitBranch: () => "feat/pyrun-pi",
			onBranchChange: () => () => {},
		},
		compact: (request: unknown) => {
			compactRequests.push(request);
		},
		getContextUsage: () => ({
			contextWindow: 200000,
			percent: 12.5,
			tokens: 25000,
		}),
		hasUI: false,
		mode: "tui",
		model: { id: "faux/model" },
		modelRegistry: {
			getAvailable: () => [
				{ id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai-codex", reasoning: true },
			],
		},
		getScopedModels: () => [],
		restart: async (request: unknown) => {
			restartRequests.push(request);
		},
		switchSession: async (sessionPath: string) => {
			switchedSessions.push(sessionPath);
			return { cancelled: false };
		},
		sessionManager: {
			getBranch: () => [],
			getCwd: () => "/repo/project",
			getSessionId: () => "pyrun-test-session",
			getSessionName: () => "pyrun work",
		},
		ui: {
			confirm: async () => false,
		},
	} as unknown as ExtensionContext;

	let toolCallIndex = 0;
	return {
		compactRequests,
		evaluateContext: ctx,
		enqueuedMessages,
		restartRequests,
		emitSessionShutdown: async () => sessionShutdownHandler?.(),
		selectedModels,
		switchedSessions,
		toolDefinition: pyrunDefinition,
		evaluate: (
			params: PyrunEvalParams,
			onUpdate?: (result: AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>) => void,
			signal?: AbortSignal,
			contextOverrides: Record<string, unknown> = {},
		) =>
			registeredPyrunTool.execute(`pyrun-test-call-${++toolCallIndex}`, params, signal, onUpdate, {
				...ctx,
				...contextOverrides,
			} as ExtensionContext),
	};
}

function persistBackgroundStore(store: MultiAgentStore | undefined): void {
	if (!store || store.getPersistenceTarget()) return;
	const root = mkdtempSync(join(tmpdir(), "pi-pyrun-store-"));
	temporaryHarnessDirectories.push(root);
	const sessionManager = SessionManager.create(root, join(root, "sessions"));
	sessionManager.setMetadataControlDbPath(getControlDbPath(root));
	store.setPersistenceSessionManager(sessionManager);
}

function hasProjectedLifecycle(store: MultiAgentStore, agentId: string, lifecycle: string): boolean {
	const persistence = store.getPersistenceTarget();
	if (!persistence) throw new Error("Expected persisted multi-agent store");
	deliverTerminalOutboxProjections({
		claimId: "pyrun-extension-test",
		controlDbPath: persistence.controlDbPath,
		now: () => new Date().toISOString(),
		store,
	});
	return store.getAgent(agentId)?.lifecycle === lifecycle;
}

function requestDetachedCancellation(store: MultiAgentStore, agentId: string): void {
	const persistence = store.getPersistenceTarget();
	if (!persistence) throw new Error("Expected persisted multi-agent store");
	const agent = readMultiAgentAgent(persistence.controlDbPath, persistence.sessionPath, agentId);
	const ownership = readMultiAgentRuntimeOwnership(persistence.controlDbPath, persistence.sessionPath, agentId);
	if (!agent || !ownership) throw new Error(`Expected detached ownership for ${agentId}`);
	const coordinator = new LifecycleCoordinator({
		controlDbPath: persistence.controlDbPath,
		createAgentId: () => "unused",
		now: () => new Date().toISOString(),
		processIdentity: testProcessIdentity("test-supervisor"),
		sessionPath: persistence.sessionPath,
	});
	const cancelled = coordinator.requestDetachedCancellation({
		agent,
		outputLabel: "Pyrun output",
		reason: "test cancellation",
		ownership,
	});
	if (!cancelled.ok) throw new Error(`Could not cancel detached Pyrun job: ${cancelled.error}`);
	store.publishLifecycleCoordinatorSnapshot(cancelled.agent);
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

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

function readProcessGroup(pid: number): number {
	const result = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`Could not read process group for PID ${pid}: ${result.stderr}`);
	return Number(result.stdout.trim());
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readToolText(result: AgentToolResult<unknown>): string {
	return result.content.map((item) => (item.type === "text" ? (item.text ?? "") : "")).join("\n");
}

const localPyrunCheckout = "/syncthing/Sync/Projects/claude/pyrun";
const localPyrunJsonl = join(localPyrunCheckout, "pyrun", "jsonl.py");
const hasLocalPyrunRunner = existsSync(localPyrunJsonl);
const hasPython3 = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

function writeFakePyrunRunner(tempDir: string): string {
	const runnerPath = join(tempDir, "fake-pyrun-runner.mjs");
	writeFileSync(
		runnerPath,
		`
const sessionValues = new Map();
let buffer = "";
const stdin = process.stdin[Symbol.asyncIterator]();

async function readNextLine() {
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length > 0) return line;
    }
    const chunk = await stdin.next();
    if (chunk.done) return undefined;
    buffer += String(chunk.value);
  }
}

async function resultFor(request) {
  const sessionId = request.session_id ?? "default";
  if (request.code === "env.secret") {
    return { type: "completed", executed: request.code, value: process.env.PI_TEST_SECRET ?? null };
  }
  if (request.code === "bridge.enabled") {
    return { type: "completed", executed: request.code, value: request.pi_bridge === true };
  }
  if (request.code === "ctx['count'] = 41\\nctx['count']") {
    sessionValues.set(sessionId, 41);
    return { type: "completed", executed: request.code, value: 41 };
  }
  if (request.code === "ctx['count'] += 1\\nctx['count']") {
    const next = (sessionValues.get(sessionId) ?? 0) + 1;
    sessionValues.set(sessionId, next);
    return { type: "completed", executed: request.code, value: next };
  }
  if (request.code === "print('hello')\\n1 + 1") {
    return {
      type: "completed",
      executed: request.code,
      console: ["hello"],
      value: 2
    };
  }
  if (request.code === "empty.result") {
    return { type: "completed", executed: request.code, value: "" };
  }
  if (request.code === "undefined.result") {
    return { type: "completed", executed: request.code };
  }
  if (request.code === "fs.write('/tmp/probe.txt', 'hello')") {
    return {
      type: "needs_approval",
      approval: {
        id: "fs.write:/tmp/probe.txt",
        tool: "fs.write",
        summary: "Write 5 bytes to /tmp/probe.txt",
        args: { path: "/tmp/probe.txt", content: "hello" }
      }
    };
  }
  if (request.code === "command.result") {
    return {
      type: "completed",
      executed: request.code,
      console: ["OUT"],
      value: 0
    };
  }
  if (request.code === "command.failed") {
    return {
      type: "completed",
      executed: request.code,
      console: ["tail error"],
      value: 2
    };
  }
  if (request.code === "print.streaming()") {
    if (request.stream_console === true) {
      process.stdout.write(JSON.stringify({ type: "console", stream: "stdout", text: "tick 1\\n" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "console", stream: "stdout", text: "tick 2\\n" }) + "\\n");
    }
    return { type: "completed", executed: request.code, console: ["tick 1", "tick 2"], value: "done" };
  }
  if (request.code === "print.giant_stream()") {
    const text = "prefix-" + "x".repeat(10 * 1024 * 1024) + "-suffix";
    if (request.stream_console === true) {
      process.stdout.write(JSON.stringify({ type: "console", stream: "stdout", text }) + "\\n");
    }
    return { type: "completed", executed: request.code, console: [text], value: "done" };
  }
  if (request.code === "print.interleaved_streams()") {
    if (request.stream_console === true) {
      process.stdout.write(JSON.stringify({ type: "console", stream: "stdout", text: "out 1\\n" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "console", stream: "stderr", text: "err 1\\n" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "console", stream: "stdout", text: "partial" }) + "\\n");
    }
    return { type: "completed", executed: request.code, console: ["out 1", "err 1", "partial"], value: "done" };
  }
  if (request.code === "print.delayed_streaming()") {
    if (request.stream_console === true) {
      process.stdout.write(JSON.stringify({ type: "console", stream: "stdout", text: "start\\n" }) + "\\n");
      await new Promise((resolve) => setTimeout(resolve, 200));
      process.stdout.write(JSON.stringify({ type: "console", stream: "stdout", text: "end\\n" }) + "\\n");
    }
    return { type: "completed", executed: request.code, console: ["start", "end"], value: "done" };
  }
  if (request.code === "raise.after_output()") {
    if (request.stream_console === true) {
      process.stdout.write(JSON.stringify({ type: "console", stream: "stderr", text: "before error" }) + "\\n");
    }
    return { type: "error", executed: request.code, console: ["before error"], error: "boom" };
  }
  if (request.code === "print.noisy_stream()") {
    if (request.stream_console === true) {
      for (let i = 0; i < 305; i += 1) {
        process.stdout.write(JSON.stringify({ type: "console", stream: "stdout", text: "line " + i + "\\n" }) + "\\n");
      }
    }
    return { type: "completed", executed: request.code, console: Array.from({ length: 300 }, (_, i) => "line " + (i + 5)), value: "done" };
  }
  if (request.code === "run.long_task()") {
    process.stdout.write(JSON.stringify({ type: "status", message: "starting long task" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "progress", message: "halfway done" }) + "\\n");
    return { type: "completed", executed: request.code, value: "done" };
  }
  if (request.code === "run.detachable()") {
    process.stdout.write(JSON.stringify({ type: "status", message: "detachable started" }) + "\\n");
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { type: "completed", executed: request.code, value: "detached-done" };
  }
  if (request.code === "run.auto_detachable()") {
    process.stdout.write(JSON.stringify({ type: "status", message: "auto detachable started" }) + "\\n");
    await new Promise((resolve) => setTimeout(resolve, 140));
    return { type: "completed", executed: request.code, value: "auto-detached-done" };
  }
  if (request.code === "run.foreground_30s()") {
    process.stdout.write(JSON.stringify({ type: "status", message: "30-second foreground started" }) + "\\n");
    await new Promise((resolve) => setTimeout(resolve, 30000));
    return { type: "completed", executed: request.code, value: "foreground-30s-done" };
  }
  if (request.code === "run.slow_detachable()") {
    process.stdout.write(JSON.stringify({ type: "status", message: "slow detachable started" }) + "\\n");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return { type: "completed", executed: request.code, value: "slow-detached-done" };
  }
  if (request.code === "run.detached_error()") {
    process.stdout.write(JSON.stringify({ type: "status", message: "detachable error started" }) + "\\n");
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { type: "error", error: "detached boom" };
  }
  if (request.code === "run.never()") {
    process.stdout.write(JSON.stringify({ type: "status", message: "still running" }) + "\\n");
    return new Promise(() => {});
  }
  if (request.code === "raise Exception('boom')") {
    throw new Error("boom");
  }
  if (request.code === "pyrun.internal_error") {
    return { type: "error", error: "Exception generated by Pyrun" };
  }
  if (request.code === "pi.footer.snapshot()") {
    return { type: "completed", executed: request.code, value: request.pi.footer };
  }
  if (request.code === "pi.models.scoped()") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "models.scoped", params: null }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.models.set('openai-codex', 'gpt-5.6-terra', 'medium')") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "models.set", params: { provider: "openai-codex", id: "gpt-5.6-terra", thinkingLevel: "medium" } }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.web_search('current Pi release')") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "tools.call", params: { name: "web_search", params: { query: "current Pi release" } } }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.commands.list()") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "commands.list", params: null }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.commands.run('usage', 'reset')") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "commands.run", params: { name: "usage", args: "reset" } }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.agents.spawn({'prompt': 'inspect X', 'context': 'fresh'})") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "agents.spawn", params: { prompt: "inspect X", context: "fresh" } }) + "\\n");
    const response = await readNextResponse();
    if (response.error) {
      return { type: "error", error: response.error };
    }
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.agents.spawn({'prompt': 'inspect X'})") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "agents.spawn", params: { prompt: "inspect X" } }) + "\\n");
    const response = await readNextResponse();
    if (response.error) {
      return { type: "error", error: response.error };
    }
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.agents.spawn({'prompt': 'inspect X', 'context': 'invalid'})") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "agents.spawn", params: { prompt: "inspect X", context: "invalid" } }) + "\\n");
    const response = await readNextResponse();
    if (response.error) {
      return { type: "error", error: response.error };
    }
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.agents.wait()") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "agents.wait", params: {} }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.agents.list({'activeOnly': True})") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "agents.list", params: { activeOnly: true } }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.agents.list()") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "agents.list", params: null }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.agents.current()") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "agents.current", params: null }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.agents.select('agent_1')") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "agents.select", params: { agentId: "agent_1" } }) + "\\n");
    const response = await readNextResponse();
    if (response.error) {
      return { type: "error", error: response.error };
    }
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.agents.select('main')") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "agents.select", params: { agentId: "main" } }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.messages.last()") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "messages.last", params: null }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.messages.enqueue({'message': 'next', 'deliverAs': 'followUp'})") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "messages.enqueue", params: { message: "next", deliverAs: "followUp" } }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.messages.send({'toAgentId': 'agent_1', 'message': 'review this'})") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "messages.send", params: { toAgentId: "agent_1", message: "review this" } }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.messages.send({'toAgentId': 'main', 'toSessionId': 'target-session', 'message': 'hello session'})") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "messages.send", params: { toAgentId: "main", toSessionId: "target-session", message: "hello session" } }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.compact({'customInstructions': 'preserve IDs'})") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "compact", params: { customInstructions: "preserve IDs" } }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.restart({'notice': 'from pyrun'})") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "restart", params: { notice: "from pyrun" } }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code.startsWith("pi.sessions.resume({'path': '") && request.code.endsWith("'})")) {
    const path = request.code.slice("pi.sessions.resume({'path': '".length, -"'})".length);
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "sessions.resume", params: { path } }) + "\\n");
    const response = await readNextResponse();
    if (response.error) {
      return { type: "error", error: response.error };
    }
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.sessions.resume({})") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "sessions.resume", params: {} }) + "\\n");
    const response = await readNextResponse();
    if (response.error) {
      return { type: "error", error: response.error };
    }
    return { type: "completed", executed: request.code, value: response.result };
  }
  return { type: "completed", executed: request.code, value: null };
}

async function readNextResponse() {
  const line = await readNextLine();
  if (line === undefined) throw new Error("response stream ended");
  return JSON.parse(line);
}

while (true) {
  const line = await readNextLine();
  if (line === undefined) break;
  const request = JSON.parse(line);
  try {
    process.stdout.write(JSON.stringify(await resultFor(request)) + "\\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ type: "completed", executed: request.code, error: error.message }) + "\\n");
  }
}
`,
	);
	chmodSync(runnerPath, 0o755);
	return runnerPath;
}

describe("pyrun extension", () => {
	let previousRunnerCommand: string | undefined;
	let previousRunner: string | undefined;
	let previousRunnerArgs: string | undefined;
	let tempDir: string;

	beforeEach(() => {
		initTheme("dark");
		previousRunnerCommand = process.env.PI_PYRUN_RUNNER_COMMAND;
		previousRunner = process.env.PI_PYRUN_RUNNER;
		previousRunnerArgs = process.env.PI_PYRUN_RUNNER_ARGS;
		tempDir = mkdtempSync(join(tmpdir(), "pi-pyrun-test-"));
		process.env.PI_PYRUN_RUNNER_COMMAND = process.execPath;
		process.env.PI_PYRUN_RUNNER_ARGS = JSON.stringify([writeFakePyrunRunner(tempDir)]);
	});

	afterEach(() => {
		vi.useRealTimers();
		for (const directory of temporaryHarnessDirectories.splice(0)) {
			rmSync(directory, { force: true, recursive: true });
		}
		if (previousRunnerCommand === undefined) {
			delete process.env.PI_PYRUN_RUNNER_COMMAND;
		} else {
			process.env.PI_PYRUN_RUNNER_COMMAND = previousRunnerCommand;
		}
		if (previousRunner === undefined) {
			delete process.env.PI_PYRUN_RUNNER;
		} else {
			process.env.PI_PYRUN_RUNNER = previousRunner;
		}
		if (previousRunnerArgs === undefined) {
			delete process.env.PI_PYRUN_RUNNER_ARGS;
		} else {
			process.env.PI_PYRUN_RUNNER_ARGS = previousRunnerArgs;
		}
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("disposes Pi request handlers during session shutdown", async () => {
		const handler = Object.assign(vi.fn(), { dispose: vi.fn() });
		const harness = createPyrunHarness({ piRequestHandlers: [handler] });

		await harness.emitSessionShutdown();

		expect(handler.dispose).toHaveBeenCalledOnce();
	});

	it("registers pyrun_eval as a Pi adapter for the canonical Pyrun JSONL runner", () => {
		const harness = createPyrunHarness();

		expect(harness.toolDefinition?.name).toBe("pyrun_eval");
		expect(harness.toolDefinition?.label).toBe("Pyrun Eval");
		expect(harness.toolDefinition?.approvalRequired).toBe(true);
		expect(harness.toolDefinition?.description).toContain("Python/Pyrun");
		expect(harness.toolDefinition?.promptGuidelines?.join("\n")).toContain("Python");
		expect(harness.toolDefinition?.promptGuidelines?.join("\n")).toContain("persistent ctx");
		expect(harness.toolDefinition?.promptGuidelines?.join("\n")).toContain("Do not compose shell strings");
		expect(harness.toolDefinition?.promptGuidelines?.join("\n")).toContain("full logs");
		expect(harness.toolDefinition?.promptGuidelines?.join("\n")).toContain(
			"cli.* builders forward output and return an exit code by default",
		);
		expect(harness.toolDefinition?.promptGuidelines?.join("\n")).toContain(".capture().run()");
		expect(harness.toolDefinition?.promptGuidelines?.join("\n")).toContain(
			"MUST NOT rerun the same command only to recover logs",
		);
		expect(harness.toolDefinition?.promptGuidelines?.join("\n")).toContain("pi.compact");
		expect(harness.toolDefinition?.promptGuidelines?.join("\n")).toContain("pi.restart");
		expect(harness.toolDefinition?.promptGuidelines?.join("\n")).toContain("pi.agents.current");
		expect(harness.toolDefinition?.promptGuidelines?.join("\n")).toContain("pi.agents.select");
		expect(harness.toolDefinition?.promptGuidelines?.join("\n")).toContain("pi.messages.last");
		expect(harness.toolDefinition?.promptGuidelines?.join("\n")).toContain("pi.messages.send");
		expect(harness.toolDefinition?.promptGuidelines?.join("\n")).toContain(
			"host, fs, cli, run, http, rg, fd, sqlite, kubectl, tools, text, seq, obj, and hr",
		);
	});

	it("resolves Pyrun runner command and JSON args from environment", () => {
		const options = resolvePyrunRunnerOptions({
			env: {
				PI_PYRUN_RUNNER_COMMAND: "python",
				PI_PYRUN_RUNNER_ARGS: '["-m","pyrun.jsonl"]',
			},
		});

		expect(options).toEqual({ args: ["-m", "pyrun.jsonl"], command: "python", env: {} });
	});

	it("uses the installed Pyrun runner even when PYTHONPATH names a local checkout", () => {
		const options = resolvePyrunRunnerOptions({ env: { PYTHONPATH: localPyrunCheckout } });

		expect(options).toEqual({ args: [], command: "pyrun-jsonl", env: {} });
	});

	it("uses pyrun-jsonl without args by default", () => {
		const options = resolvePyrunRunnerOptions({ env: {} });

		expect(options).toEqual({ args: [], command: "pyrun-jsonl", env: {} });
	});

	it("can start the Pyrun runner without inheriting process.env", async () => {
		const previousSecret = process.env.PI_TEST_SECRET;
		process.env.PI_TEST_SECRET = "host-secret";
		const runner = new PyrunRunnerClient({
			args: [writeFakePyrunRunner(tempDir)],
			command: process.execPath,
			env: {},
			inheritEnv: false,
		});
		try {
			const result = await runner.evaluate({ code: "env.secret" });
			expect(result.value).toBeNull();
		} finally {
			runner.dispose();
			if (previousSecret === undefined) delete process.env.PI_TEST_SECRET;
			else process.env.PI_TEST_SECRET = previousSecret;
		}
	});

	it("can evaluate Pyrun with the Pi bridge disabled", async () => {
		const runner = new PyrunRunnerClient({ args: [writeFakePyrunRunner(tempDir)], command: process.execPath });
		try {
			const evaluate = createPyrunEvalExecutor(runner, undefined, { enablePiBridge: false });
			const result = await evaluate({ code: "bridge.enabled" }, createPyrunHarness().evaluateContext);
			expect(result.details.value).toBe(false);
		} finally {
			runner.dispose();
		}
	});

	it("does not resolve a replacement request with stale output from the old runner generation", async () => {
		const counterPath = join(tempDir, "runner-generation.txt");
		const runnerPath = join(tempDir, "generation-race-runner.mjs");
		writeFileSync(counterPath, "0");
		writeFileSync(
			runnerPath,
			`import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const counterPath = process.env.COUNTER_PATH;
if (!counterPath) throw new Error("COUNTER_PATH is required");
const generation = Number(readFileSync(counterPath, "utf8"));
writeFileSync(counterPath, String(generation + 1));

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (generation === 0) {
    process.stdout.write(JSON.stringify({ type: "completed", executed: request.code, value: "old" }) + "\\n");
    spawn(
      process.execPath,
      ["-e", "setTimeout(() => process.stdout.write(JSON.stringify({ type: 'completed', executed: 'stale', value: 'stale-old' }) + '\\\\n'), 100)"],
      { stdio: ["ignore", "inherit", "ignore"] },
    );
  } else {
    setTimeout(() => {
      process.stderr.write("replacement failed\\n");
      process.exit(23);
    }, 250);
  }
}
`,
		);
		const runner = new PyrunRunnerClient({
			args: [runnerPath],
			command: process.execPath,
			detached: false,
			env: { COUNTER_PATH: counterPath },
		});
		try {
			await expect(runner.evaluate({ code: "old" })).resolves.toMatchObject({ value: "old" });
			runner.dispose();
			await expect(runner.evaluate({ code: "replacement" })).rejects.toThrow(/exit code 23/);
		} finally {
			runner.dispose();
		}
	});

	it("runs Pyrun inside bwrap without host environment or Pi bridge access", async () => {
		const previousPythonPath = process.env.PYTHONPATH;
		const previousSecret = process.env.PI_TEST_SECRET;
		process.env.PYTHONPATH = "/home/osso";
		process.env.PI_TEST_SECRET = "host-secret";
		const fakeBwrap = writeFakeBwrap(tempDir);
		const settingsManager = SettingsManager.inMemory({ sandboxProfile: "read-only" });
		const harness = createPyrunHarness({ bwrapCommand: fakeBwrap.command } as PyrunHarnessOptions);
		try {
			const bridge = await harness.evaluate({ code: "bridge.enabled" }, undefined, undefined, {
				cwd: tempDir,
				settingsManager,
			});
			const secret = await harness.evaluate({ code: "env.secret" }, undefined, undefined, {
				cwd: tempDir,
				settingsManager,
			});

			expect(bridge.details.value).toBe(false);
			expect(secret.details.value).toBeNull();
			const invocation = JSON.parse(readFileSync(fakeBwrap.logPath, "utf8")) as string[];
			expect(invocation).toContain("--ro-bind");
			expect(invocation).toContain(tempDir);
			expect(invocation).not.toEqual(expect.arrayContaining(["--setenv", "PYTHONPATH", "/home/osso"]));
			expect(invocation).not.toEqual(expect.arrayContaining(["--ro-bind", "/home/osso", "/home/osso"]));
		} finally {
			if (previousPythonPath === undefined) delete process.env.PYTHONPATH;
			else process.env.PYTHONPATH = previousPythonPath;
			if (previousSecret === undefined) delete process.env.PI_TEST_SECRET;
			else process.env.PI_TEST_SECRET = previousSecret;
		}
	});

	it("renders Pyrun code in the tool call before execution starts", () => {
		const harness = createPyrunHarness();
		const component = new ToolExecutionComponent(
			"pyrun_eval",
			"pyrun-render-test-call",
			{ code: "run.sleep(10)" },
			{},
			harness.toolDefinition,
			createFakeTui(),
			process.cwd(),
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("pyrun_eval");
		expect(rendered).toContain("run.sleep(10)");
	});

	it("shows non-default Pyrun session id in the tool title", () => {
		const harness = createPyrunHarness();
		const component = new ToolExecutionComponent(
			"pyrun_eval",
			"pyrun-render-test-call",
			{ code: "run.sleep(10)", session_id: "worker" },
			{},
			harness.toolDefinition,
			createFakeTui(),
			process.cwd(),
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("pyrun_eval(worker)");
		expect(rendered).not.toContain("Session: worker");
	});

	it("syntax-colors Pyrun Python in the call row without repeating it in the result", () => {
		const harness = createPyrunHarness();
		const component = new ToolExecutionComponent(
			"pyrun_eval",
			"pyrun-render-test-call",
			{ code: "value = run.sleep(10)" },
			{},
			harness.toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: 'value = run.sleep(10)\n\nResult: {"success":true}' }],
				details: { executed: "value = run.sleep(10)", type: "completed" },
				isError: false,
			},
			false,
		);

		const rendered = component.render(120).join("\n");
		const plain = stripAnsi(rendered);
		expect(rendered).toContain("\x1b[");
		expect(plain.split("value = run.sleep(10)")).toHaveLength(2);
		expect(plain).toContain('Result: {"success":true}');
		expect(plain).not.toContain("Session: default");
	});

	it("uses shared lifecycle timing for streamed success and buffered failure rendering", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const harness = createPyrunHarness();
		const streamed = new ToolExecutionComponent(
			"pyrun_eval",
			"pyrun-streamed-timing",
			{ code: "print.delayed_streaming()" },
			{},
			harness.toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		streamed.markExecutionStarted(1_000);
		vi.setSystemTime(3_500);
		streamed.updateResult(
			{
				content: [{ type: "text", text: "start\n" }],
				details: { stream: "stdout", text: "start\n", type: "console" },
				isError: false,
			},
			true,
		);
		expect(stripAnsi(streamed.render(120).join("\n"))).toContain("Elapsed: 2s");
		streamed.updateResult(
			{
				content: [{ type: "text", text: "print.delayed_streaming()\n\nstart\nend\ndone" }],
				details: { console: ["start", "end"], type: "completed", value: "done" },
				isError: false,
			},
			false,
			5_000,
		);
		vi.setSystemTime(10_000);
		expect(stripAnsi(streamed.render(120).join("\n"))).toContain("Elapsed: 4s");

		const bufferedFailure = new ToolExecutionComponent(
			"pyrun_eval",
			"pyrun-buffered-timing",
			{ code: "raise Exception('boom')" },
			{},
			harness.toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		bufferedFailure.markExecutionStarted(2_000);
		bufferedFailure.updateResult(
			{
				content: [{ type: "text", text: "raise Exception('boom')\n\nSession: default\nError: boom" }],
				details: { error: "boom", executed: "raise Exception('boom')", type: "error" },
				isError: true,
			},
			false,
			5_500,
		);
		const bufferedFailureRendered = stripAnsi(bufferedFailure.render(120).join("\n"));
		expect(bufferedFailureRendered).toContain("Elapsed: 3s");
		expect(bufferedFailureRendered).not.toContain("Error: Session: default");

		const immediateFailure = new ToolExecutionComponent(
			"pyrun_eval",
			"pyrun-immediate-failure-timing",
			{ code: "cli.command('./missing').run()" },
			{},
			harness.toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		immediateFailure.markExecutionStarted(6_000);
		immediateFailure.updateResult(
			{
				content: [{ type: "text", text: "Error: No such file or directory" }],
				details: { error: "No such file or directory", type: "error" },
				isError: true,
			},
			false,
			6_084,
		);
		expect(stripAnsi(immediateFailure.render(120).join("\n"))).toContain("Elapsed: 84ms");
	});

	it("replaces live console rendering with the final result without duplication", () => {
		const harness = createPyrunHarness();
		const component = new ToolExecutionComponent(
			"pyrun_eval",
			"pyrun-render-test-call",
			{ code: "raise.after_output()" },
			{},
			harness.toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "before error" }],
				details: { stream: "stderr", text: "before error", type: "console" },
				isError: false,
			},
			true,
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "raise.after_output()\n\nSession: default\nbefore error\nError: boom" }],
				details: {
					console: ["before error"],
					error: "boom",
					executed: "raise.after_output()",
					type: "error",
				},
				isError: true,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.split("before error")).toHaveLength(2);
		expect(rendered).toContain("Error: boom");
	});

	it("delegates evaluation to the Pyrun JSONL runner process", async () => {
		const harness = createPyrunHarness();

		const result = await harness.evaluate({ code: "print('hello')\n1 + 1" });

		expect(result.details).toEqual({
			console: ["hello"],
			executed: "print('hello')\n1 + 1",
			type: "completed",
			value: 2,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("print('hello')\n1 + 1");
		expect(text).toContain("\n2");
		expect(text).not.toContain("Result:");
		expect(text).toContain("hello");
	});

	it("records detached Pyrun result and completion notification", async () => {
		const store = new MultiAgentStore();
		const detachRegistry = new ToolDetachRegistry();
		const harness = createPyrunHarness({ backgroundJobs: { store }, detachRegistry });

		const evaluation = harness.evaluate({ code: "run.detachable()" }, undefined, undefined, {
			toolExecutionStartedAt: Date.now() - 1_000,
		});
		await waitFor(() => detachRegistry.detachRunning(), "detached Pyrun evaluation");
		const detached = await evaluation;
		expect(detached.details).toMatchObject({ backgroundJobId: "pyrun_1" });

		await waitFor(() => hasProjectedLifecycle(store, "pyrun_1", "completed"), "detached Pyrun completion");
		const agent = store.getAgent("pyrun_1");
		expect(agent?.result?.summary).toBe("Pyrun evaluation completed.");
		expect(agent?.result?.durationMs).toBeGreaterThanOrEqual(1_000);
		const notification = store.listPendingLifecycleNotificationsForAgent("pyrun_1", "completed")[0]?.body;
		expect(notification).toContain("Pyrun evaluation completed");
		expect(notification).toMatch(/Duration: \d+ms/);
	});

	it("omits empty Pyrun result values", async () => {
		const harness = createPyrunHarness();

		const emptyResult = await harness.evaluate({ code: "empty.result" });
		const undefinedResult = await harness.evaluate({ code: "undefined.result" });
		const nullResult = await harness.evaluate({ code: "null.result" });

		expect(emptyResult.content[0]).toEqual({
			type: "text",
			text: "empty.result\n",
		});
		expect(undefinedResult.content[0]).toEqual({
			type: "text",
			text: "undefined.result\n",
		});
		expect(nullResult.content[0]).toEqual({
			type: "text",
			text: "null.result\n",
		});
	});

	it("shows the run command exit code after command output", async () => {
		const harness = createPyrunHarness();

		const result = await harness.evaluate({ code: "command.result" });

		expect(result.content[0]).toEqual({
			type: "text",
			text: "command.result\n\nOUT\n0",
		});
	});

	it("shows failed run command output and numeric exit code", async () => {
		const harness = createPyrunHarness();

		const result = await harness.evaluate({ code: "command.failed" });

		expect(result.content[0]).toEqual({
			type: "text",
			text: "command.failed\n\ntail error\n2",
		});
	});

	it.runIf(hasLocalPyrunRunner && hasPython3)("evaluates code through the real local Pyrun JSONL runner", async () => {
		delete process.env.PI_PYRUN_RUNNER_COMMAND;
		delete process.env.PI_PYRUN_RUNNER;
		delete process.env.PI_PYRUN_RUNNER_ARGS;
		const harness = createPyrunHarness();

		const result = await harness.evaluate({ code: "print('hello')\n1+1" });

		expect(result.details).toEqual({
			console: ["hello"],
			executed: "print('hello')\n1+1",
			type: "completed",
			value: 2,
		});
		expect(result.content[0]).toEqual({
			type: "text",
			text: "print('hello')\n1+1\n\nhello\n2",
		});
	});

	it("lists scoped models through the Pi bridge", async () => {
		const harness = createPyrunHarness();

		const result = await harness.evaluate({ code: "pi.models.scoped()" }, undefined, undefined, {
			getScopedModels: () => [
				{
					model: { id: "gpt-5.5", name: "GPT-5.5", provider: "openai-codex" },
					thinkingLevel: "high",
				},
				{
					model: { id: "claude-opus-4-8", provider: "anthropic" },
				},
			],
		});

		expect(result.details.value).toEqual([
			{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai-codex", thinkingLevel: "high" },
			{ id: "claude-opus-4-8", provider: "anthropic" },
		]);
	});

	it("sets an available model and optional thinking level through the Pi bridge", async () => {
		const harness = createPyrunHarness();

		const result = await harness.evaluate({
			code: "pi.models.set('openai-codex', 'gpt-5.6-terra', 'medium')",
		});

		expect(result.details.value).toEqual({
			model: { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai-codex", reasoning: true },
			thinkingLevel: "medium",
		});
		expect(harness.selectedModels).toEqual([
			{ id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai-codex", reasoning: true },
		]);
	});

	it("keeps Pyrun session state in the runner", async () => {
		const harness = createPyrunHarness();

		const first = await harness.evaluate({ code: "ctx['count'] = 41\nctx['count']", session_id: "session-1" });
		const second = await harness.evaluate({ code: "ctx['count'] += 1\nctx['count']", session_id: "session-1" });

		expect(first.details.value).toBe(41);
		expect(second.details.value).toBe(42);
	});

	it("returns canonical Pyrun approval requests", async () => {
		const harness = createPyrunHarness();

		const result = await harness.evaluate({ code: "fs.write('/tmp/probe.txt', 'hello')" });

		expect(result.details).toEqual({
			approval: {
				args: { content: "hello", path: "/tmp/probe.txt" },
				id: "fs.write:/tmp/probe.txt",
				summary: "Write 5 bytes to /tmp/probe.txt",
				tool: "fs.write",
			},
			type: "needs_approval",
		});
	});

	it("requests and forwards streaming console output before the completed result", async () => {
		const harness = createPyrunHarness();
		const updates: Array<AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>> = [];

		const result = await harness.evaluate({ code: "print.streaming()" }, (update) => updates.push(update));

		expect(updates.map((update) => readToolText(update))).toEqual(["tick 1\n", "tick 1\ntick 2\n"]);
		expect(result.details).toEqual({
			console: ["tick 1", "tick 2"],
			executed: "print.streaming()",
			type: "completed",
			value: "done",
		});
	});

	it("caps a giant newline-free streamed console chunk while preserving its tail", async () => {
		const harness = createPyrunHarness();
		const updates: Array<AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>> = [];

		const result = await harness.evaluate({ code: "print.giant_stream()" }, (update) => updates.push(update));

		const lastUpdate = updates.at(-1);
		if (!lastUpdate) throw new Error("Expected streamed update");
		const streamedText = readToolText(lastUpdate);
		expect(Buffer.byteLength(streamedText)).toBeLessThanOrEqual(1_048_576);
		expect(streamedText).toContain("-suffix");
		expect(streamedText).not.toContain("prefix-");
		const progressText = lastUpdate.details;
		if (progressText.type !== "console" || typeof progressText.text !== "string") {
			throw new Error("Expected bounded console progress details");
		}
		expect(Buffer.byteLength(progressText.text)).toBeLessThanOrEqual(1_048_576);
		const finalConsole = result.details?.console?.[0];
		if (typeof finalConsole !== "string") throw new Error("Expected bounded final console text");
		expect(Buffer.byteLength(finalConsole)).toBeLessThanOrEqual(1_048_576);
		expect(finalConsole).toContain("-suffix");
		expect(finalConsole).not.toContain("prefix-");
	});

	it("bounds final console history by actual newline lines", () => {
		const result = formatCanonicalPyrunEvalResult(
			{ code: "history" },
			{
				console: Array.from({ length: 200 }, (_, index) => `old-${index}\nnew-${index}`),
				type: "completed",
			},
		);
		const entries = result.details?.console ?? [];
		const lineCount = entries.reduce((count, entry) => {
			const text = typeof entry === "string" ? entry : entry.message;
			return count + (text.endsWith("\n") ? text.slice(0, -1).split("\n").length : text.split("\n").length);
		}, 0);

		expect(lineCount).toBe(300);
		expect(readToolText(result)).toContain("old-50\nnew-50");
		expect(readToolText(result)).not.toContain("old-49\nnew-49");
		expect(readToolText(result)).toContain("old-199\nnew-199");
	});

	it("uses the same visible progress formatting for durable foreground evaluations", async () => {
		const store = new MultiAgentStore();
		const detachRegistry = new ToolDetachRegistry();
		const harness = createPyrunHarness({ backgroundJobs: { store }, detachRegistry });
		const updates: Array<AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>> = [];

		const result = await harness.evaluate({ code: "print.streaming()" }, (update) => updates.push(update));

		expect(updates.map((update) => readToolText(update))).toEqual(["tick 1\n", "tick 1\ntick 2\n"]);
		expect(readToolText(result)).toBe("print.streaming()\n\ntick 1\ntick 2\ndone");
		expect(store.listAgents()).toEqual([]);
	});

	it("preserves stdout and stderr console event order including partial text", async () => {
		const harness = createPyrunHarness();
		const updates: Array<AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>> = [];

		const result = await harness.evaluate({ code: "print.interleaved_streams()" }, (update) => updates.push(update));

		expect(updates.map((update) => update.details)).toEqual([
			{ type: "console", stream: "stdout", text: "out 1\n" },
			{ type: "console", stream: "stderr", text: "err 1\n" },
			{ type: "console", stream: "stdout", text: "partial" },
		]);
		expect(readToolText(updates.at(-1) ?? { content: [], details: undefined })).toBe("out 1\nerr 1\npartial");
		expect(readToolText(result)).toBe("print.interleaved_streams()\n\nout 1\nerr 1\npartial\ndone");
	});

	it("forwards the first console line while evaluation remains active", async () => {
		const harness = createPyrunHarness();
		const updates: Array<AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>> = [];
		let completed = false;

		const evaluation = harness.evaluate({ code: "print.delayed_streaming()" }, (update) => updates.push(update));
		void evaluation.then(() => {
			completed = true;
		});
		await waitFor(() => updates.some((update) => readToolText(update) === "start\n"), "first console line");

		expect(completed).toBe(false);
		expect(readToolText(await evaluation)).toBe("print.delayed_streaming()\n\nstart\nend\ndone");
	});

	it("retains streamed console history in an error result without duplicate final text", async () => {
		const harness = createPyrunHarness();
		const updates: Array<AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>> = [];

		const result = await harness.evaluate({ code: "raise.after_output()" }, (update) => updates.push(update));

		expect(updates.map((update) => readToolText(update))).toEqual(["before error"]);
		expect(result.isError).toBe(true);
		expect(readToolText(result)).toBe("raise.after_output()\n\nbefore error\nError: boom");
	});

	it("caps accumulated streaming console output to the final console line limit", async () => {
		const harness = createPyrunHarness();
		let lastUpdateText = "";

		await harness.evaluate({ code: "print.noisy_stream()" }, (update) => {
			lastUpdateText = readToolText(update);
		});

		expect(lastUpdateText.split("\n").filter(Boolean)).toEqual(
			Array.from({ length: 300 }, (_, i) => `line ${i + 5}`),
		);
	});

	it("streams Pyrun in-progress output before the completed result", async () => {
		const harness = createPyrunHarness();
		const updates: Array<AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>> = [];

		const result = await harness.evaluate({ code: "run.long_task()" }, (update) => updates.push(update));

		expect(updates.map((update) => update.details)).toEqual([
			{ type: "status", message: "starting long task" },
			{ type: "progress", message: "halfway done" },
		]);
		expect(result.details).toEqual({
			executed: "run.long_task()",
			type: "completed",
			value: "done",
		});
	});

	it("marks Pyrun eval errors as final tool errors", async () => {
		const harness = createPyrunHarness();

		const result = await harness.evaluate({ code: "raise Exception('boom')" });

		expect(result.isError).toBe(true);
		expect(result.details).toEqual({
			error: "boom",
			executed: "raise Exception('boom')",
			type: "completed",
		});
		expect(result.content[0]).toEqual({
			type: "text",
			text: "raise Exception('boom')\n\nError: boom",
		});
	});

	it("settles Pyrun type:error messages as final tool errors", async () => {
		const harness = createPyrunHarness();

		const result = await Promise.race([
			harness.evaluate({ code: "pyrun.internal_error" }),
			new Promise((_, reject) => setTimeout(() => reject(new Error("Pyrun type:error did not settle")), 500)),
		]);

		expect(result).toMatchObject({
			details: { error: "Exception generated by Pyrun", type: "error" },
			isError: true,
		});
	});

	it("sends Pi footer snapshot data to the Pyrun runner", async () => {
		const harness = createPyrunHarness();

		const result = await harness.evaluate({ code: "pi.footer.snapshot()" });

		expect(result.details.value).toEqual({
			availableProviderCount: 3,
			branch: "feat/pyrun-pi",
			contextUsage: {
				contextWindow: 200000,
				percent: 12.5,
				tokens: 25000,
			},
			cwd: "/repo/project",
			extensionStatuses: {
				agent: "idle",
				pyrun: "ready",
			},
			model: "faux/model",
			sessionName: "pyrun work",
		} satisfies PyrunPiCapabilitySnapshot["footer"]);
	});

	it.runIf(hasLocalPyrunRunner && hasPython3)(
		"sends Pi footer snapshot through the real local Pyrun runner",
		async () => {
			delete process.env.PI_PYRUN_RUNNER_COMMAND;
			delete process.env.PI_PYRUN_RUNNER;
			delete process.env.PI_PYRUN_RUNNER_ARGS;
			const harness = createPyrunHarness();

			const result = await harness.evaluate({ code: "pi.footer.snapshot()" });

			expect(result.details.value).toMatchObject({
				availableProviderCount: 3,
				branch: "feat/pyrun-pi",
				cwd: "/repo/project",
				model: "faux/model",
				sessionName: "pyrun work",
			});
		},
	);

	it("responds to Pyrun pi.tools.call requests through active Pi tools", async () => {
		const harness = createPyrunHarness({
			callTool: async (name, params, _signal, toolCallId) => ({
				content: [{ type: "text", text: "Pi release notes" }],
				details: { name, params, toolCallId },
			}),
		});

		const result = await harness.evaluate({ code: "pi.web_search('current Pi release')" });

		expect(result.details.value).toEqual({
			content: [{ type: "text", text: "Pi release notes" }],
			details: {
				name: "web_search",
				params: { query: "current Pi release" },
				toolCallId: "pyrun-test-call-1",
			},
		});
	});

	it.runIf(hasLocalPyrunRunner && hasPython3)(
		"forwards the enclosing Pyrun tool-call identity through ExtensionAPI.callTool",
		async () => {
			delete process.env.PI_PYRUN_RUNNER_COMMAND;
			delete process.env.PI_PYRUN_RUNNER;
			delete process.env.PI_PYRUN_RUNNER_ARGS;
			let nestedToolCallId: string | undefined;
			const harness = await createHarness({
				extensionFactories: [pyrunExtension],
				tools: [
					{
						name: "spawn_agent",
						label: "Spawn Agent",
						description: "Capture inherited spawn identity",
						parameters: Type.Object({ context: Type.Literal("inherit"), prompt: Type.String() }),
						execute: async (toolCallId) => {
							nestedToolCallId = toolCallId;
							return { content: [{ type: "text", text: "captured" }], details: {} };
						},
					},
				],
			});
			await harness.session.bindExtensions({});
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall(
						"pyrun_eval",
						{
							code: "pi.tools.call('spawn_agent', {'prompt': 'Child assignment', 'context': 'inherit'})",
						},
						{ id: "enclosing-pyrun-call" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);

			try {
				await harness.session.prompt("Run nested inherited spawn");

				expect(nestedToolCallId).toBe("enclosing-pyrun-call");
			} finally {
				harness.cleanup();
			}
		},
	);

	it("lists slash commands from Pyrun pi.commands.list", async () => {
		const harness = createPyrunHarness();

		const result = await harness.evaluate({ code: "pi.commands.list()" });

		expect(result.details.value).toEqual([{ name: "usage", source: "extension" }]);
	});

	it("runs slash commands from Pyrun pi.commands.run", async () => {
		const calls: Array<{ args: string | undefined; name: string }> = [];
		const harness = createPyrunHarness({
			callCommand: async (name, args) => {
				calls.push({ name, args });
				return { displayed: true };
			},
		});

		const result = await harness.evaluate({ code: "pi.commands.run('usage', 'reset')" });

		expect(calls).toEqual([{ name: "usage", args: "reset" }]);
		expect(result.details.value).toEqual({ displayed: true });
	});

	it("responds to Pyrun pi.agents.spawn requests through configured handlers", async () => {
		const requests: Array<{ method: string; params: unknown }> = [];
		const harness = createPyrunHarness({
			piRequestHandlers: [
				(request) => {
					requests.push(request);
					return { agent: { id: "agent-1" }, dispatched: true, prompt: "inspect X" };
				},
			],
		});

		const result = await harness.evaluate({
			code: "pi.agents.spawn({'prompt': 'inspect X', 'context': 'fresh'})",
		});

		expect(requests).toEqual([{ method: "agents.spawn", params: { prompt: "inspect X", context: "fresh" } }]);
		expect(result.details.value).toEqual({ agent: { id: "agent-1" }, dispatched: true, prompt: "inspect X" });
	});

	it.runIf(hasLocalPyrunRunner && hasPython3)(
		"excludes the active Pyrun assistant turn when pi.tools.call spawns an inherited child",
		async () => {
			delete process.env.PI_PYRUN_RUNNER_COMMAND;
			delete process.env.PI_PYRUN_RUNNER;
			delete process.env.PI_PYRUN_RUNNER_ARGS;
			const root = mkdtempSync(join(tmpdir(), "pi-pyrun-inherit-"));
			temporaryHarnessDirectories.push(root);
			const sessionManager = SessionManager.create(root, join(root, "sessions"));
			sessionManager.setMetadataControlDbPath(getControlDbPath(root));
			sessionManager.appendMessage({ role: "user", content: "Completed parent prefix", timestamp: 1 });
			sessionManager.appendMessage(fauxAssistantMessage("Completed parent response"));
			const code = "pi.tools.call('spawn_agent', {'prompt': 'Child assignment', 'context': 'inherit'})";
			sessionManager.appendMessage(
				fauxAssistantMessage(fauxToolCall("pyrun_eval", { code }, { id: "pyrun-test-call-1" }), {
					stopReason: "toolUse",
				}),
			);
			const store = new MultiAgentStore({ now: () => "2026-06-30T00:00:00.000Z" });
			store.setPersistenceSessionManager(sessionManager);
			let childSessionManager: SessionManager | undefined;
			const createChildSession = createProductionChildAgentSessionFactory({
				createSessionManager: SessionManager.create,
				multiAgentStore: store,
				createSession: async (options) => {
					childSessionManager = options.sessionManager;
					return {
						session: {
							bindExtensions: async () => {},
							get messages() {
								return options.sessionManager?.buildSessionContext().messages ?? [];
							},
							prompt: async (prompt) => {
								options.sessionManager?.appendMessage({ role: "user", content: prompt, timestamp: 2 });
								options.sessionManager?.appendMessage(fauxAssistantMessage("Child complete"));
							},
						},
					};
				},
			});
			const handler = createMultiAgentPiRequestHandler({ createChildSession, store }, {
				appendEntry: (customType: string, data?: unknown) => sessionManager.appendCustomEntry(customType, data),
			} satisfies ParentAgentJournalWriter);
			let bridgeContext: ExtensionContext;
			const harness = createPyrunHarness({
				callTool: async (name, params, signal, toolCallId) => {
					if (name !== "spawn_agent") throw new Error(`Unexpected tool: ${name}`);
					const details = await handler({ method: "agents.spawn", params }, bridgeContext, signal, toolCallId);
					return { content: [], details };
				},
			});
			bridgeContext = { ...harness.evaluateContext, sessionManager } as ExtensionContext;

			await harness.evaluate({ code }, undefined, undefined, { sessionManager });

			expect(childSessionManager?.buildSessionContext().messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"user",
				"assistant",
			]);
			expect(
				childSessionManager
					?.buildSessionContext()
					.messages.map((message) =>
						message.role === "user" && typeof message.content === "string" ? message.content : message.role,
					),
			).toEqual(["Completed parent prefix", "assistant", "Child assignment", "assistant"]);
		},
	);

	it("rejects Pyrun pi.agents.spawn requests without context through the multi-agent handler", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-30T00:00:00.000Z" });
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		sessionManager.setMetadataControlDbPath(getControlDbPath(tempDir));
		store.setPersistenceSessionManager(sessionManager);
		const createChildSession = vi.fn(async () => ({
			messages: [fauxAssistantMessage("done")],
			prompt: async () => {},
		}));
		const harness = createPyrunHarness({
			piRequestHandlers: [
				createMultiAgentPiRequestHandler({ createChildSession, store }, {
					appendEntry: (customType: string, data?: unknown) => sessionManager.appendCustomEntry(customType, data),
				} satisfies ParentAgentJournalWriter),
			],
		});

		const result = await harness.evaluate({ code: "pi.agents.spawn({'prompt': 'inspect X'})" });

		expect(result.isError).toBe(true);
		expect(result.details.error).toContain("context");
		expect(createChildSession).not.toHaveBeenCalled();
		expect(store.listAgents()).toEqual([]);
	});

	it("rejects Pyrun pi.agents.spawn requests with invalid context through the multi-agent handler", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-30T00:00:00.000Z" });
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		sessionManager.setMetadataControlDbPath(getControlDbPath(tempDir));
		store.setPersistenceSessionManager(sessionManager);
		const createChildSession = vi.fn(async () => ({
			messages: [fauxAssistantMessage("done")],
			prompt: async () => {},
		}));
		const harness = createPyrunHarness({
			piRequestHandlers: [
				createMultiAgentPiRequestHandler({ createChildSession, store }, {
					appendEntry: (customType: string, data?: unknown) => sessionManager.appendCustomEntry(customType, data),
				} satisfies ParentAgentJournalWriter),
			],
		});

		const result = await harness.evaluate({
			code: "pi.agents.spawn({'prompt': 'inspect X', 'context': 'invalid'})",
		});

		expect(result.isError).toBe(true);
		expect(result.details.error).toContain("context");
		expect(createChildSession).not.toHaveBeenCalled();
		expect(store.listAgents()).toEqual([]);
	});

	it.each([
		["missing", { context: "fresh" }],
		["non-string", { context: "fresh", prompt: 42 }],
	])("rejects Pyrun pi.agents.spawn requests with %s prompt", async (_case, params) => {
		const store = new MultiAgentStore({ now: () => "2026-06-30T00:00:00.000Z" });
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		sessionManager.setMetadataControlDbPath(getControlDbPath(tempDir));
		store.setPersistenceSessionManager(sessionManager);
		const createChildSession = vi.fn(async () => ({
			messages: [fauxAssistantMessage("done")],
			prompt: async () => {},
		}));
		const handler = createMultiAgentPiRequestHandler({ createChildSession, store }, {
			appendEntry: (customType: string, data?: unknown) => sessionManager.appendCustomEntry(customType, data),
		} satisfies ParentAgentJournalWriter);
		const harness = createPyrunHarness();
		const bridgeContext = { ...harness.evaluateContext, sessionManager } as ExtensionContext;

		await expect(handler({ method: "agents.spawn", params }, bridgeContext, undefined)).rejects.toThrow("prompt");

		expect(createChildSession).not.toHaveBeenCalled();
		expect(store.listAgents()).toEqual([]);
	});

	it("responds to Pyrun pi.agents.wait requests through configured handlers", async () => {
		const harness = createPyrunHarness({
			piRequestHandlers: [
				(request) => {
					if (request.method !== "agents.wait") return undefined;
					return null;
				},
			],
		});

		const result = await harness.evaluate({ code: "pi.agents.wait()" });

		expect(result.details.value).toBeNull();
	});

	it("returns null from Pyrun pi.agents.wait through the multi-agent handler", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-30T00:00:00.000Z" });
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		sessionManager.setMetadataControlDbPath(getControlDbPath(tempDir));
		store.setPersistenceSessionManager(sessionManager);
		const harness = createPyrunHarness({
			piRequestHandlers: [
				createMultiAgentPiRequestHandler(
					{
						createChildSession: async ({ agent }) => ({
							messages: [fauxAssistantMessage("done")],
							prompt: async () => {},
							transcript: {
								path: join(tempDir, `${agent.id}.jsonl`),
								sessionId: `session-${agent.id}`,
							},
						}),
						store,
					},
					{
						appendEntry: (customType: string, data?: unknown) =>
							sessionManager.appendCustomEntry(customType, data),
					} satisfies ParentAgentJournalWriter,
				),
			],
		});

		await harness.evaluate({ code: "pi.agents.spawn({'prompt': 'inspect X', 'context': 'fresh'})" });
		const result = await harness.evaluate({ code: "pi.agents.wait()" });

		expect(result.details.value).toBeNull();
		expect(store.getAgent("agent_1")).toMatchObject({ lifecycle: "completed", result: { summary: "done" } });
	});

	it("treats null from Pyrun pi.agents.wait as a handled result", async () => {
		const harness = createPyrunHarness({
			piRequestHandlers: [
				(request) => {
					if (request.method !== "agents.wait") return undefined;
					return null;
				},
			],
		});

		const result = await harness.evaluate({ code: "pi.agents.wait()" });

		expect(result.details.value).toBeNull();
	});

	it("responds to Pyrun pi.agents.current requests through the multi-agent handler", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-30T00:00:00.000Z" });
		const spawned = legacyMultiAgentStore(store).spawnAgent({
			agentType: "scout",
			cwd: "/repo/project",
			displayName: "Scout",
			permission: { narrowed: true, policy: "on-request" },
		});
		store.selectAgentView(spawned.agent.id);
		const harness = createPyrunHarness({
			piRequestHandlers: [createMultiAgentPiRequestHandler({ store })],
		});

		const result = await harness.evaluate({ code: "pi.agents.current()" });

		expect(result.details.value).toMatchObject({ agent: { displayName: "Scout", id: spawned.agent.id } });
	});

	it("returns main thread from Pyrun pi.agents.current when selected view is inactive", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-30T00:00:00.000Z" });
		const spawned = legacyMultiAgentStore(store).spawnAgent({
			agentType: "scout",
			cwd: "/repo/project",
			displayName: "Scout",
			permission: { narrowed: true, policy: "on-request" },
		});
		expect(
			legacyMultiAgentStore(store).transitionAgent(spawned.agent.id, spawned.agent.revision, "completed").ok,
		).toBe(true);
		store.selectAgentView(spawned.agent.id);
		const harness = createPyrunHarness({
			piRequestHandlers: [createMultiAgentPiRequestHandler({ store })],
		});

		const result = await harness.evaluate({ code: "pi.agents.current()" });

		expect(result.details.value).toEqual({
			agent: { displayName: "Main thread", id: "main", lifecycle: "current", selected: true },
		});
		expect(store.getSelectedAgentId()).toBe(spawned.agent.id);
	});

	it("returns main thread from Pyrun pi.agents.current when no agent is selected", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-30T00:00:00.000Z" });
		const harness = createPyrunHarness({
			piRequestHandlers: [createMultiAgentPiRequestHandler({ store })],
		});

		const result = await harness.evaluate({ code: "pi.agents.current()" });

		expect(result.details.value).toEqual({
			agent: { displayName: "Main thread", id: "main", lifecycle: "current", selected: true },
		});
	});

	it("selects child and main thread from Pyrun pi.agents.select through the multi-agent handler", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-30T00:00:00.000Z" });
		const spawned = legacyMultiAgentStore(store).spawnAgent({
			agentType: "scout",
			cwd: "/repo/project",
			displayName: "Scout",
			permission: { narrowed: true, policy: "on-request" },
		});
		const harness = createPyrunHarness({
			piRequestHandlers: [createMultiAgentPiRequestHandler({ store })],
		});

		const selected = await harness.evaluate({ code: "pi.agents.select('agent_1')" });
		const main = await harness.evaluate({ code: "pi.agents.select('main')" });

		expect(selected.details.value).toMatchObject({ agent: { id: spawned.agent.id, displayName: "Scout" } });
		expect(main.details.value).toEqual({
			agent: { displayName: "Main thread", id: "main", lifecycle: "current", selected: true },
		});
		expect(store.getSelectedAgentId()).toBeUndefined();
	});

	it("selects completed agents for persistent read-only viewing from Pyrun", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-30T00:00:00.000Z" });
		const spawned = legacyMultiAgentStore(store).spawnAgent({
			agentType: "scout",
			cwd: "/repo/project",
			displayName: "Scout",
			permission: { narrowed: true, policy: "on-request" },
		});
		expect(
			legacyMultiAgentStore(store).transitionAgent(spawned.agent.id, spawned.agent.revision, "completed").ok,
		).toBe(true);
		const harness = createPyrunHarness({
			piRequestHandlers: [createMultiAgentPiRequestHandler({ store })],
		});

		const selected = await harness.evaluate({ code: "pi.agents.select('agent_1')" });

		expect(selected.details.value).toMatchObject({
			agent: { id: spawned.agent.id, displayName: "Scout", lifecycle: "completed" },
		});
		expect(store.getSelectedAgentId()).toBe(spawned.agent.id);
		expect(store.selectAgentView(spawned.agent.id)).toMatchObject({ id: spawned.agent.id, lifecycle: "completed" });
	});

	it("returns bounded last session message from Pyrun pi.messages.last", async () => {
		const longToolBlob = "x".repeat(6000);
		const harness = createPyrunHarness({
			piRequestHandlers: [createMultiAgentPiRequestHandler({ store: new MultiAgentStore() })],
		});
		const sessionManager = {
			getBranch: () => [
				{
					id: "entry-1",
					message: { content: longToolBlob, role: "assistant", timestamp: 1 },
					parentId: null,
					timestamp: "2026-06-30T00:00:00.000Z",
					type: "message",
				},
			],
			getCwd: () => "/repo/project",
			getEntries: () => [],
			getSessionName: () => "pyrun work",
		};

		const result = await harness.evaluate({ code: "pi.messages.last()" }, undefined, undefined, { sessionManager });

		expect(result.details.value).toEqual({
			content: "x".repeat(2000),
			entryId: "entry-1",
			role: "assistant",
			text: "x".repeat(2000),
			truncated: true,
		});
	});

	it("responds to Pyrun pi.agents.list requests through configured handlers", async () => {
		const harness = createPyrunHarness({
			piRequestHandlers: [
				(request) => {
					if (request.method !== "agents.list") return undefined;
					return { activeCount: 1, agents: [{ id: "agent-1", lifecycle: "running" }] };
				},
			],
		});

		const result = await harness.evaluate({ code: "pi.agents.list({'activeOnly': True})" });

		expect(result.details.value).toEqual({ activeCount: 1, agents: [{ id: "agent-1", lifecycle: "running" }] });
	});

	it("accepts no-arg Pyrun pi.agents.list requests with null params", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-30T00:00:00.000Z" });
		const spawned = legacyMultiAgentStore(store).spawnAgent({
			agentType: "scout",
			cwd: "/repo/project",
			displayName: "Scout",
			permission: { narrowed: true, policy: "on-request" },
		});
		const harness = createPyrunHarness({
			piRequestHandlers: [createMultiAgentPiRequestHandler({ store })],
		});

		const result = await harness.evaluate({ code: "pi.agents.list()" });

		expect(result.details.value).toMatchObject({
			activeCount: 1,
			agents: [{ id: spawned.agent.id, displayName: "Scout" }],
		});
	});

	it("enqueues user messages from Pyrun pi.messages.enqueue", async () => {
		const harness = createPyrunHarness();

		const result = await harness.evaluate({
			code: "pi.messages.enqueue({'message': 'next', 'deliverAs': 'followUp'})",
		});

		expect(result.details.value).toEqual({ enqueued: true });
		expect(harness.enqueuedMessages).toEqual([{ content: "next", options: { deliverAs: "followUp" } }]);
	});

	it("sends agent messages from Pyrun pi.messages.send through the multi-agent handler", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-30T00:00:00.000Z" });
		const spawned = legacyMultiAgentStore(store).spawnAgent({
			agentType: "scout",
			cwd: "/repo/project",
			displayName: "Scout",
			permission: { narrowed: true, policy: "on-request" },
		});
		const harness = createPyrunHarness({
			piRequestHandlers: [createMultiAgentPiRequestHandler({ store })],
		});

		const result = await harness.evaluate({
			code: "pi.messages.send({'toAgentId': 'agent_1', 'message': 'review this'})",
		});

		expect(result.details.value).toMatchObject({
			message: {
				body: "review this",
				error: "Runtime mailbox transport is unavailable.",
				fromAgentId: "main",
				status: "failed",
				toAgentId: spawned.agent.id,
			},
		});
		expect(store.listPendingMailboxMessagesForAgent(spawned.agent.id)).toEqual([]);
	});

	it("sends runtime session messages from Pyrun pi.messages.send through the multi-agent handler", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-30T00:00:00.000Z" });
		const harness = createPyrunHarness({
			piRequestHandlers: [createMultiAgentPiRequestHandler({ store })],
		});

		const result = await harness.evaluate({
			code: "pi.messages.send({'toAgentId': 'main', 'toSessionId': 'target-session', 'message': 'hello session'})",
		});

		expect(result.details.value).toMatchObject({
			message: { body: "hello session", fromAgentId: "main", toAgentId: "main" },
		});
	});

	it("starts Pi compaction directly from Pyrun pi.compact", async () => {
		const harness = createPyrunHarness();

		const result = await harness.evaluate({
			code: "pi.compact({'customInstructions': 'preserve IDs'})",
		});

		expect(result.details.value).toEqual({ started: true });
		expect(harness.compactRequests).toEqual([{ customInstructions: "preserve IDs" }]);
		expect(harness.enqueuedMessages).toEqual([]);
	});

	it("restarts Pi from Pyrun pi.restart", async () => {
		const harness = createPyrunHarness();

		const result = await harness.evaluate({
			code: "pi.restart({'notice': 'from pyrun'})",
		});

		expect(result.details.value).toEqual({ started: true });
		expect(harness.restartRequests).toEqual([{ notice: "from pyrun", process: true }]);
	});

	it("resumes a target Pi session in-process from Pyrun pi.sessions.resume", async () => {
		const targetSessionFile = join(tempDir, "target-session.jsonl");
		writeFileSync(targetSessionFile, "");
		const harness = createPyrunHarness();

		const result = await harness.evaluate({
			code: `pi.sessions.resume({'path': '${targetSessionFile}'})`,
		});

		expect(result.details.value).toEqual({ cancelled: false, resumed: true });
		expect(harness.restartRequests).toEqual([]);
		expect(harness.switchedSessions).toEqual([targetSessionFile]);
	});

	it("rejects empty Pyrun pi.sessions.resume targets", async () => {
		const harness = createPyrunHarness();

		const result = await harness.evaluate({ code: "pi.sessions.resume({})" });

		expect(result.isError).toBe(true);
		expect(result.details.error).toBe("pi.sessions.resume requires exactly one of path, id, or name");
		expect(harness.restartRequests).toEqual([]);
		expect(harness.switchedSessions).toEqual([]);
	});

	it("rejects Pyrun pi.sessions.resume when session switching is unavailable", async () => {
		const targetSessionFile = join(tempDir, "target-session.jsonl");
		writeFileSync(targetSessionFile, "");
		const harness = createPyrunHarness();

		const result = await harness.evaluate(
			{ code: `pi.sessions.resume({'path': '${targetSessionFile}'})` },
			undefined,
			undefined,
			{ switchSession: undefined },
		);

		expect(result.isError).toBe(true);
		expect(result.details.error).toBe("pi.sessions.resume is not available in this session mode");
		expect(harness.switchedSessions).toEqual([]);
	});

	it("preserves foreground Pi bridge requests without creating an agent", async () => {
		const store = new MultiAgentStore({ now: () => "2026-07-05T00:00:00.000Z" });
		const detachRegistry = new ToolDetachRegistry();
		const harness = createPyrunHarness({ backgroundJobs: { store }, detachRegistry });

		const result = await harness.evaluate({ code: "pi.commands.list()" });

		expect(result.details.value).toEqual([{ name: "usage", source: "extension" }]);
		expect(store.listAgents()).toEqual([]);
	});

	it("keeps a 30-second evaluation in the foreground before the configured detach threshold", async () => {
		const store = new MultiAgentStore({ now: () => "2026-07-05T00:00:00.000Z" });
		const detachRegistry = new ToolDetachRegistry({ autoDetachAfterMs: 35_000 });
		const harness = createPyrunHarness({ backgroundJobs: { store }, detachRegistry });

		const result = await harness.evaluate({ code: "run.foreground_30s()" });

		expect(result.details.value).toBe("foreground-30s-done");
		expect(store.listAgents()).toEqual([]);
	}, 35_000);

	it("does not detach an evaluation that already completed in the foreground runner", async () => {
		const store = new MultiAgentStore({ now: () => "2026-07-05T00:00:00.000Z" });
		const detachRegistry = new ToolDetachRegistry();
		const harness = createPyrunHarness({ backgroundJobs: { store }, detachRegistry });

		const result = await harness.evaluate({ code: "empty.result" });

		expect(detachRegistry.detachRunning()).toBe(false);
		expect(result.details.value).toBe("");
		expect(store.listAgents()).toEqual([]);
	});

	it("completes a claimed foreground Pi bridge request when detachment races its response", async () => {
		const store = new MultiAgentStore({ now: () => "2026-07-05T00:00:00.000Z" });
		const detachRegistry = new ToolDetachRegistry();
		let toolCalls = 0;
		const harness = createPyrunHarness({
			backgroundJobs: { store },
			callTool: async () => {
				toolCalls += 1;
				await delay(100);
				return { content: [{ type: "text", text: "done" }], details: { ok: true } };
			},
			detachRegistry,
		});

		const resultPromise = harness.evaluate({ code: "pi.web_search('current Pi release')" });
		await waitFor(() => toolCalls === 1, "foreground bridge claim");
		expect(detachRegistry.detachRunning()).toBe(true);
		const result = await resultPromise;

		expect(result.details.backgroundJobId).toBe("pyrun_1");
		await waitFor(() => hasProjectedLifecycle(store, "pyrun_1", "completed"), "detached bridge completion");
		expect(toolCalls).toBe(1);
	});

	it("does not create an agent for a foreground Pyrun evaluation", async () => {
		const store = new MultiAgentStore({ now: () => "2026-07-05T00:00:00.000Z" });
		const detachRegistry = new ToolDetachRegistry();
		const harness = createPyrunHarness({ backgroundJobs: { store }, detachRegistry });

		const result = await harness.evaluate({ code: "empty.result" });

		expect(result.details.value).toBe("");
		expect(store.listAgents()).toEqual([]);
	});

	it("creates the reported detached Pyrun log path before evaluation completes", async () => {
		const store = new MultiAgentStore({ now: () => "2026-07-05T00:00:00.000Z" });
		const detachRegistry = new ToolDetachRegistry();
		const harness = createPyrunHarness({ backgroundJobs: { store }, detachRegistry });
		const updates: Array<AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>> = [];

		const resultPromise = harness.evaluate({ code: "run.slow_detachable()" }, (update) => updates.push(update));
		await waitFor(() => updates.some((update) => update.details.type === "status"), "Pyrun progress before detach");
		expect(detachRegistry.detachRunning()).toBe(true);

		const result = await resultPromise;
		const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
		const logPath = resultText.match(/Output will be written to (.+)\./)?.[1];
		expect(logPath).toBeDefined();
		const [job] = store.listAgents();
		expect(job.lifecycle).toBe("running");
		expect(logPath ? existsSync(logPath) : false).toBe(true);
		expect(logPath ? readFileSync(logPath, "utf8") : "").toContain('"kind":"progress"');
		const runningFileRefs = store.getAgent(job.id)?.result?.fileRefs ?? [];
		expect(runningFileRefs[0]).toMatchObject({ label: "Pyrun output", path: logPath });
		expect(runningFileRefs[1]).toMatchObject({ label: "Pyrun script" });
		const scriptPath = runningFileRefs[1]?.path;
		expect(scriptPath ? readFileSync(scriptPath, "utf8") : undefined).toBe("run.slow_detachable()");
		expect(scriptPath ? statSync(scriptPath).mode & 0o777 : undefined).toBe(0o600);

		await waitFor(() => hasProjectedLifecycle(store, job.id, "completed"), "detached Pyrun completion");
		expect(store.getAgent(job.id)?.result?.fileRefs).toEqual(runningFileRefs);
	});

	it("auto-detaches a running Pyrun evaluation after the registry threshold", async () => {
		const store = new MultiAgentStore({ now: () => "2026-07-05T00:00:00.000Z" });
		const detachRegistry = new ToolDetachRegistry({ autoDetachAfterMs: 80 });
		const harness = createPyrunHarness({ backgroundJobs: { store }, detachRegistry });
		const result = await harness.evaluate({ code: "run.auto_detachable()" });
		const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(resultText).toContain("Pyrun evaluation moved to background as job");
		expect(result.details?.backgroundJobId).toBeDefined();
		expect(result.details?.type).toBe("detached");

		const jobs = store.listAgents();
		expect(jobs).toHaveLength(1);
		const [job] = jobs;
		expect(job).toMatchObject({ agentType: "background", displayName: "Pyrun evaluation", lifecycle: "running" });
		await waitFor(() => hasProjectedLifecycle(store, job.id, "completed"), "auto-detached Pyrun completion");
	});

	it("keeps foreground Pyrun evaluations unblocked after detaching a background job", async () => {
		const store = new MultiAgentStore({ now: () => "2026-07-05T00:00:00.000Z" });
		const detachRegistry = new ToolDetachRegistry();
		const harness = createPyrunHarness({ backgroundJobs: { store }, detachRegistry });
		const updates: Array<AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>> = [];

		const backgroundPromise = harness.evaluate({ code: "run.slow_detachable()" }, (update) => updates.push(update));
		await waitFor(() => updates.some((update) => update.details.type === "status"), "Pyrun progress before detach");
		expect(detachRegistry.detachRunning()).toBe(true);
		await backgroundPromise;

		const foregroundResult = await Promise.race([
			harness.evaluate({ code: "empty.result" }),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("foreground Pyrun remained queued")), 5_000),
			),
		]);

		expect(foregroundResult.details.value).toBe("");
		const [job] = store.listAgents();
		expect(job.lifecycle).toBe("running");
		await waitFor(() => hasProjectedLifecycle(store, job.id, "completed"), "detached Pyrun completion");
	});

	it("detaches a running Pyrun evaluation into the multi-agent job store", async () => {
		const store = new MultiAgentStore({ now: () => "2026-07-05T00:00:00.000Z" });
		const detachRegistry = new ToolDetachRegistry();
		const harness = createPyrunHarness({ backgroundJobs: { store }, detachRegistry });
		const updates: Array<AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>> = [];

		const resultPromise = harness.evaluate({ code: "run.detachable()" }, (update) => updates.push(update));
		await waitFor(() => updates.some((update) => update.details.type === "status"), "Pyrun progress before detach");
		expect(detachRegistry.detachRunning()).toBe(true);

		const result = await resultPromise;
		const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(resultText).toContain("Pyrun evaluation moved to background as job");
		expect(result.details?.backgroundJobId).toBeDefined();
		expect(result.details?.type).toBe("detached");

		const jobs = store.listAgents();
		expect(jobs).toHaveLength(1);
		const [job] = jobs;
		expect(job).toMatchObject({ agentType: "background", displayName: "Pyrun evaluation", lifecycle: "running" });
		const [runningFileRef] = store.getAgent(job.id)?.result?.fileRefs ?? [];
		expect(runningFileRef).toMatchObject({ label: "Pyrun output" });
		await waitFor(() => hasProjectedLifecycle(store, job.id, "completed"), "detached Pyrun completion");
		expect(store.getAgent(job.id)?.result?.summary).toContain("Pyrun evaluation completed");
		const [fileRef] = store.getAgent(job.id)?.result?.fileRefs ?? [];
		expect(fileRef).toEqual(runningFileRef);
		expect(fileRef?.path && existsSync(fileRef.path)).toBe(true);
		expect(fileRef?.path ? stripAnsi(readFileSync(fileRef.path, "utf8")) : "").toContain("detached-done");
		expect(fileRef?.path ? stripAnsi(readFileSync(fileRef.path, "utf8")) : "").not.toContain("Result:");
	});

	it("marks detached Pyrun evaluation errors as failed jobs", async () => {
		const store = new MultiAgentStore({ now: () => "2026-07-05T00:00:00.000Z" });
		const detachRegistry = new ToolDetachRegistry();
		const harness = createPyrunHarness({ backgroundJobs: { store }, detachRegistry });
		const updates: Array<AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>> = [];

		const resultPromise = harness.evaluate(
			{ code: "run.detached_error()" },
			(update) => updates.push(update),
			undefined,
			{ toolExecutionStartedAt: Date.now() - 1_000 },
		);
		await waitFor(
			() => updates.some((update) => update.details.type === "status"),
			"Pyrun error progress before detach",
		);
		expect(detachRegistry.detachRunning()).toBe(true);
		await resultPromise;

		const [job] = store.listAgents();
		const runningFileRefs = store.getAgent(job.id)?.result?.fileRefs;
		expect(runningFileRefs?.[1]).toMatchObject({ label: "Pyrun script" });
		await waitFor(() => hasProjectedLifecycle(store, job.id, "failed"), "detached Pyrun failure");
		expect(store.getAgent(job.id)?.result?.fileRefs).toEqual(runningFileRefs);
		expect(store.getAgent(job.id)?.result?.summary).toContain("detached boom");
		expect(store.getAgent(job.id)?.result?.durationMs).toBeGreaterThanOrEqual(1_000);
		expect(store.listPendingLifecycleNotificationsForAgent(job.id, "failed")[0]?.body).toMatch(/Duration: \d+ms/);
	});

	it("aborts a detached Pyrun evaluation through its agent runtime handle", async () => {
		const store = new MultiAgentStore({ now: () => "2026-07-05T00:00:00.000Z" });
		const detachRegistry = new ToolDetachRegistry();
		const harness = createPyrunHarness({ backgroundJobs: { store }, detachRegistry });
		const updates: Array<AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>> = [];

		const resultPromise = harness.evaluate({ code: "run.never()" }, (update) => updates.push(update));
		await waitFor(() => updates.some((update) => update.details.type === "status"), "Pyrun progress before detach");
		expect(detachRegistry.detachRunning()).toBe(true);
		await resultPromise;

		const [job] = store.listAgents();
		const runningFileRefs = store.getAgent(job.id)?.result?.fileRefs;
		expect(runningFileRefs?.[1]).toMatchObject({ label: "Pyrun script" });
		expect(store.abortAgentHandle(job.id)).toBe(false);
		requestDetachedCancellation(store, job.id);
		await waitFor(() => hasProjectedLifecycle(store, job.id, "aborted"), "detached Pyrun cancellation");
		expect(store.getAgent(job.id)?.result?.fileRefs).toEqual(runningFileRefs);
		expect(store.abortAgentHandle(job.id)).toBe(false);
	});

	it.skipIf(process.platform === "win32")("can inherit the caller process group", async () => {
		const runnerPidPath = join(tempDir, "inherited-group-pyrun-runner.pid");
		const runnerPath = join(tempDir, "inherited-group-pyrun-runner.mjs");
		writeFileSync(
			runnerPath,
			`import { writeFileSync } from "node:fs";
writeFileSync(process.env.RUNNER_PID_PATH, String(process.pid));
process.stdin.on("data", () => {
  process.stdout.write(JSON.stringify({ type: "status", message: "running" }) + "\\n");
});
setInterval(() => {}, 1000);
`,
		);
		const runner = new PyrunRunnerClient({
			args: [runnerPath],
			command: process.execPath,
			detached: false,
			env: { RUNNER_PID_PATH: runnerPidPath },
		});
		const evaluation = runner.evaluate({ code: "run.never()" }).catch((error: unknown) => error);
		await waitFor(() => existsSync(runnerPidPath), "inherited Pyrun runner PID");
		const runnerPid = Number(readFileSync(runnerPidPath, "utf8"));
		try {
			expect(readProcessGroup(runnerPid)).toBe(readProcessGroup(process.pid));
		} finally {
			runner.dispose();
		}
		expect(await evaluation).toEqual(
			expect.objectContaining({ message: expect.stringContaining("Pyrun runner exited") }),
		);
	});

	it("keeps a replacement Pyrun runner after the aborted runner exits", async () => {
		const runnerPidPath = join(tempDir, "delayed-exit-pyrun-runner.pid");
		const runnerPath = join(tempDir, "delayed-exit-pyrun-runner.mjs");
		writeFileSync(
			runnerPath,
			`import { writeFileSync } from "node:fs";
let buffer = "";
let value;
writeFileSync(process.env.RUNNER_PID_PATH, String(process.pid));
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 100));
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.code === "run.never()") {
      process.stdout.write(JSON.stringify({ type: "status", message: "still running" }) + "\\n");
      continue;
    }
    if (request.code === "set.value") value = 41;
    process.stdout.write(JSON.stringify({ type: "completed", value }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`,
		);
		const runner = new PyrunRunnerClient({
			args: [runnerPath],
			command: process.execPath,
			env: { RUNNER_PID_PATH: runnerPidPath },
		});
		try {
			const controller = new AbortController();
			const aborted = runner.evaluate({ code: "run.never()" }, () => controller.abort(), controller.signal);
			await expect(aborted).rejects.toThrow("Pyrun evaluation aborted");

			expect((await runner.evaluate({ code: "set.value" })).value).toBe(41);
			await delay(150);
			expect((await runner.evaluate({ code: "get.value" })).value).toBe(41);
		} finally {
			runner.dispose();
		}
		const runnerPid = Number(readFileSync(runnerPidPath, "utf8"));
		await waitFor(() => !processIsAlive(runnerPid), "replacement Pyrun runner cleanup");
	});

	it.skipIf(process.platform === "win32")(
		"kills Pyrun runner subprocesses when an evaluation is aborted",
		async () => {
			const childPidPath = join(tempDir, "pyrun-child.pid");
			const runnerPath = join(tempDir, "pyrun-runner-with-child.mjs");
			writeFileSync(
				runnerPath,
				`import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
let started = false;
process.stdin.on("data", () => {
  if (started) return;
  started = true;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(process.env.CHILD_PID_PATH, String(child.pid));
  process.stdout.write(JSON.stringify({ type: "status", message: "child started" }) + "\\n");
});
setInterval(() => {}, 1000);
`,
			);
			const runner = new PyrunRunnerClient({
				args: [runnerPath],
				command: process.execPath,
				env: { CHILD_PID_PATH: childPidPath },
			});
			let childPid = 0;
			try {
				const controller = new AbortController();
				const evaluation = runner.evaluate(
					{ code: "run.child_forever()" },
					() => controller.abort(),
					controller.signal,
				);

				await expect(evaluation).rejects.toThrow("Pyrun evaluation aborted");
				childPid = Number(readFileSync(childPidPath, "utf8"));
				await waitFor(() => !processIsAlive(childPid), "Pyrun subprocess termination");
			} finally {
				runner.dispose();
				if (childPid !== 0 && processIsAlive(childPid)) process.kill(childPid, "SIGKILL");
			}
			expect(processIsAlive(childPid)).toBe(false);
		},
	);

	it("aborts an in-progress Pyrun evaluation when the agent signal is aborted", async () => {
		const harness = createPyrunHarness();
		const controller = new AbortController();
		const updates: Array<AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>> = [];
		const result = harness.evaluate(
			{ code: "run.never()" },
			(update) => {
				updates.push(update);
				if (update.details.type === "status") {
					controller.abort();
				}
			},
			controller.signal,
		);

		await expect(
			Promise.race([
				result,
				new Promise((_, reject) => setTimeout(() => reject(new Error("Pyrun abort did not settle")), 500)),
			]),
		).rejects.toThrow("Pyrun evaluation aborted");
		expect(updates.map((update) => update.details)).toEqual([{ type: "status", message: "still running" }]);
	});

	it("rejects a failed foreground runner without creating an agent", async () => {
		const badRunnerPath = join(tempDir, "bad-foreground-pyrun-runner.mjs");
		writeFileSync(badRunnerPath, 'process.stderr.write("bad foreground runner\\n"); process.exit(7);\n');
		process.env.PI_PYRUN_RUNNER_ARGS = JSON.stringify([badRunnerPath]);
		const store = new MultiAgentStore({ now: () => "2026-07-05T00:00:00.000Z" });
		const detachRegistry = new ToolDetachRegistry();
		const harness = createPyrunHarness({ backgroundJobs: { store }, detachRegistry });

		await expect(harness.evaluate({ code: "1 + 1" })).rejects.toThrow(
			"Pyrun runner exited with exit code 7\nbad foreground runner",
		);
		expect(store.listAgents()).toEqual([]);
	});

	it("reports runner exit errors with stderr", async () => {
		const badRunnerPath = join(tempDir, "bad-pyrun-runner.mjs");
		writeFileSync(badRunnerPath, 'process.stderr.write("bad runner\\n"); process.exit(7);\n');
		process.env.PI_PYRUN_RUNNER_ARGS = JSON.stringify([badRunnerPath]);
		const harness = createPyrunHarness();

		await expect(harness.evaluate({ code: "1 + 1" })).rejects.toThrow(
			"Pyrun runner exited with exit code 7\nbad runner",
		);
	});
});
