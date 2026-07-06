import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostrunMultiAgentRequestHandler } from "../extensions/agents-core/src/runtime.ts";
import pyrunExtension, { type PyrunExtensionOptions } from "../extensions/pyrun/src/index.ts";
import { resolvePyrunRunnerOptions } from "../extensions/pyrun/src/runner.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { ToolDetachRegistry } from "../src/core/tool-detach-registry.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

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
	type: "completed" | "error" | "needs_approval";
	value?: unknown;
}

interface PyrunProgressDetails {
	executed?: string;
	message?: string;
	type: string;
}

type PyrunHarnessOptions = PyrunExtensionOptions & {
	callTool?: ExtensionAPI["callTool"];
};

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
	let pyrunTool: PyrunTool | undefined;
	let pyrunDefinition: ToolDefinition | undefined;
	const compactRequests: unknown[] = [];
	const enqueuedMessages: Array<{ content: unknown; options: unknown }> = [];
	const restartRequests: unknown[] = [];
	const switchedSessions: string[] = [];

	const pi = {
		callTool: options.callTool ?? (async () => ({ content: [], details: undefined })),
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
			getSessionName: () => "pyrun work",
		},
		ui: {
			confirm: async () => false,
		},
	} as unknown as ExtensionContext;

	return {
		compactRequests,
		enqueuedMessages,
		restartRequests,
		switchedSessions,
		toolDefinition: pyrunDefinition,
		evaluate: (
			params: PyrunEvalParams,
			onUpdate?: (result: AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>) => void,
			signal?: AbortSignal,
			contextOverrides: Record<string, unknown> = {},
		) =>
			registeredPyrunTool.execute("pyrun-test-call", params, signal, onUpdate, {
				...ctx,
				...contextOverrides,
			} as ExtensionContext),
	};
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
      value: { stdout: "OUT\\n", stderr: "", exit_code: 0, upstream_results: [] }
    };
  }
  if (request.code === "command.failed") {
    return {
      type: "completed",
      executed: request.code,
      console: ["tail error"],
      value: { stdout: "full out\\n", stderr: "full error\\n", exit_code: 2, upstream_results: [] }
    };
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
  if (request.code === "pi.web_search('current Pi release')") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "tools.call", params: { name: "web_search", params: { query: "current Pi release" } } }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.agents.spawn({'prompt': 'inspect X'})") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "agents.spawn", params: { prompt: "inspect X" } }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.agents.wait('agent-1')" || request.code === "pi.agents.wait('agent_1')") {
    const agentId = request.code.includes("agent_1") ? "agent_1" : "agent-1";
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "agents.wait", params: { agentId } }) + "\\n");
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

	it("uses local Pyrun checkout by default when present", () => {
		const options = resolvePyrunRunnerOptions({
			env: {},
			exists: (path) => path === localPyrunJsonl,
		});

		expect(options).toEqual({
			args: ["-m", "pyrun.jsonl"],
			command: "python3",
			env: { PYTHONPATH: localPyrunCheckout },
		});
	});

	it("uses pyrun-jsonl without args by default when no local checkout exists", () => {
		const options = resolvePyrunRunnerOptions({ env: {}, exists: () => false });

		expect(options).toEqual({ args: [], command: "pyrun-jsonl", env: {} });
	});

	it("renders only the Pyrun title before execution starts", () => {
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
		expect(rendered).not.toContain("run.sleep(10)");
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

	it("syntax-colors Pyrun Python in the interactive result row", () => {
		const harness = createPyrunHarness();
		const component = new ToolExecutionComponent(
			"pyrun_eval",
			"pyrun-render-test-call",
			{},
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
		expect(rendered).toContain("\x1b[");
		expect(stripAnsi(rendered)).toContain("value = run.sleep(10)");
		expect(stripAnsi(rendered)).not.toContain("Session: default");
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

	it("omits successful command result JSON when command output is already shown", async () => {
		const harness = createPyrunHarness();

		const result = await harness.evaluate({ code: "command.result" });

		expect(result.content[0]).toEqual({
			type: "text",
			text: "command.result\n\nOUT",
		});
	});

	it("summarizes failed command results without repeating full logs", async () => {
		const harness = createPyrunHarness();

		const result = await harness.evaluate({ code: "command.failed" });

		expect(result.content[0]).toEqual({
			type: "text",
			text: "command.failed\n\ntail error\nexit code 2",
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

	it("streams Pyrun in-progress output before the completed result", async () => {
		const harness = createPyrunHarness();
		const updates: Array<AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>> = [];

		const result = await harness.evaluate({ code: "run.long_task()" }, (update) => updates.push(update));

		expect(updates.map((update) => update.details)).toEqual([
			{ type: "running", executed: "run.long_task()" },
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
			text: "raise Exception('boom')\n\nSession: default\nError: boom",
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
			callTool: async (name, params) => ({
				content: [{ type: "text", text: "Pi release notes" }],
				details: { name, params },
			}),
		});

		const result = await harness.evaluate({ code: "pi.web_search('current Pi release')" });

		expect(result.details.value).toEqual({
			content: [{ type: "text", text: "Pi release notes" }],
			details: { name: "web_search", params: { query: "current Pi release" } },
		});
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

		const result = await harness.evaluate({ code: "pi.agents.spawn({'prompt': 'inspect X'})" });

		expect(requests).toEqual([{ method: "agents.spawn", params: { prompt: "inspect X" } }]);
		expect(result.details.value).toEqual({ agent: { id: "agent-1" }, dispatched: true, prompt: "inspect X" });
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

		const result = await harness.evaluate({ code: "pi.agents.wait('agent-1')" });

		expect(result.details.value).toBeNull();
	});

	it("returns null from Pyrun pi.agents.wait through the multi-agent handler", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-30T00:00:00.000Z" });
		const harness = createPyrunHarness({
			piRequestHandlers: [
				createHostrunMultiAgentRequestHandler({
					dispatcher: async () => ({ lifecycle: "completed", result: { summary: "done" } }),
					store,
				}),
			],
		});

		await harness.evaluate({ code: "pi.agents.spawn({'prompt': 'inspect X'})" });
		const result = await harness.evaluate({ code: "pi.agents.wait('agent_1')" });

		expect(result.details.value).toBeNull();
		expect(store.getAgent("agent_1")).toMatchObject({ lifecycle: "completed", result: { summary: "done" } });
	});

	it("responds to Pyrun pi.agents.current requests through the multi-agent handler", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-30T00:00:00.000Z" });
		const spawned = store.spawnAgent({
			agentType: "scout",
			cwd: "/repo/project",
			displayName: "Scout",
			lifecycle: "starting",
			permission: { narrowed: true, policy: "on-request" },
		});
		store.selectAgentView(spawned.agent.id);
		const harness = createPyrunHarness({
			piRequestHandlers: [createHostrunMultiAgentRequestHandler({ store })],
		});

		const result = await harness.evaluate({ code: "pi.agents.current()" });

		expect(result.details.value).toMatchObject({ agent: { displayName: "Scout", id: spawned.agent.id } });
	});

	it("returns main thread from Pyrun pi.agents.current when selected view is inactive", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-30T00:00:00.000Z" });
		const spawned = store.spawnAgent({
			agentType: "scout",
			cwd: "/repo/project",
			displayName: "Scout",
			lifecycle: "starting",
			permission: { narrowed: true, policy: "on-request" },
		});
		const running = store.transitionAgent(spawned.agent.id, spawned.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) {
			throw new Error("expected run to succeed");
		}
		expect(store.transitionAgent(spawned.agent.id, running.agent.revision, "completed").ok).toBe(true);
		store.selectAgentView(spawned.agent.id);
		const harness = createPyrunHarness({
			piRequestHandlers: [createHostrunMultiAgentRequestHandler({ store })],
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
			piRequestHandlers: [createHostrunMultiAgentRequestHandler({ store })],
		});

		const result = await harness.evaluate({ code: "pi.agents.current()" });

		expect(result.details.value).toEqual({
			agent: { displayName: "Main thread", id: "main", lifecycle: "current", selected: true },
		});
	});

	it("selects child and main thread from Pyrun pi.agents.select through the multi-agent handler", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-30T00:00:00.000Z" });
		const spawned = store.spawnAgent({
			agentType: "scout",
			cwd: "/repo/project",
			displayName: "Scout",
			lifecycle: "starting",
			permission: { narrowed: true, policy: "on-request" },
		});
		const harness = createPyrunHarness({
			piRequestHandlers: [createHostrunMultiAgentRequestHandler({ store })],
		});

		const selected = await harness.evaluate({ code: "pi.agents.select('agent_1')" });
		const main = await harness.evaluate({ code: "pi.agents.select('main')" });

		expect(selected.details.value).toMatchObject({ agent: { id: spawned.agent.id, displayName: "Scout" } });
		expect(main.details.value).toEqual({
			agent: { displayName: "Main thread", id: "main", lifecycle: "current", selected: true },
		});
		expect(store.getSelectedAgentId()).toBeUndefined();
	});

	it("rejects inactive agents from Pyrun pi.agents.select", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-30T00:00:00.000Z" });
		const spawned = store.spawnAgent({
			agentType: "scout",
			cwd: "/repo/project",
			displayName: "Scout",
			lifecycle: "starting",
			permission: { narrowed: true, policy: "on-request" },
		});
		const running = store.transitionAgent(spawned.agent.id, spawned.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) {
			throw new Error("expected run to succeed");
		}
		expect(store.transitionAgent(spawned.agent.id, running.agent.revision, "completed").ok).toBe(true);
		const harness = createPyrunHarness({
			piRequestHandlers: [createHostrunMultiAgentRequestHandler({ store })],
		});

		const selected = await harness.evaluate({ code: "pi.agents.select('agent_1')" });

		expect(selected.details.error).toBe("Agent is not active: Scout (completed)");
		expect(store.getSelectedAgentId()).toBeUndefined();
		expect(store.selectAgentView(spawned.agent.id)).toMatchObject({ id: spawned.agent.id, lifecycle: "completed" });
	});

	it("returns bounded last session message from Pyrun pi.messages.last", async () => {
		const longToolBlob = "x".repeat(6000);
		const harness = createPyrunHarness({
			piRequestHandlers: [createHostrunMultiAgentRequestHandler({ store: new MultiAgentStore() })],
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
		const spawned = store.spawnAgent({
			agentType: "scout",
			cwd: "/repo/project",
			displayName: "Scout",
			lifecycle: "starting",
			permission: { narrowed: true, policy: "on-request" },
		});
		const harness = createPyrunHarness({
			piRequestHandlers: [createHostrunMultiAgentRequestHandler({ store })],
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
		const spawned = store.spawnAgent({
			agentType: "scout",
			cwd: "/repo/project",
			displayName: "Scout",
			lifecycle: "starting",
			permission: { narrowed: true, policy: "on-request" },
		});
		const harness = createPyrunHarness({
			piRequestHandlers: [createHostrunMultiAgentRequestHandler({ store })],
		});

		const result = await harness.evaluate({
			code: "pi.messages.send({'toAgentId': 'agent_1', 'message': 'review this'})",
		});

		expect(result.details.value).toMatchObject({
			message: { body: "review this", fromAgentId: "main", toAgentId: spawned.agent.id },
		});
		expect(store.listPendingMailboxMessagesForAgent(spawned.agent.id)).toMatchObject([
			{ body: "review this", fromAgentId: "main" },
		]);
	});

	it("sends runtime session messages from Pyrun pi.messages.send through the multi-agent handler", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-30T00:00:00.000Z" });
		const harness = createPyrunHarness({
			piRequestHandlers: [createHostrunMultiAgentRequestHandler({ store })],
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
		expect(logPath ? readFileSync(logPath, "utf8") : "").toContain("Pyrun evaluation is still running");
		const [runningArtifact] = store.listArtifacts(job.id);
		expect(runningArtifact).toMatchObject({ kind: "log", path: logPath, title: "Pyrun output" });

		await waitFor(() => store.getAgent(job.id)?.lifecycle === "completed", "detached Pyrun completion");
	});

	it("auto-detaches a running Pyrun evaluation after the registry threshold", async () => {
		const store = new MultiAgentStore({ now: () => "2026-07-05T00:00:00.000Z" });
		const detachRegistry = new ToolDetachRegistry({ autoDetachAfterMs: 80 });
		const harness = createPyrunHarness({ backgroundJobs: { store }, detachRegistry });
		const updates: Array<AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>> = [];

		const resultPromise = harness.evaluate({ code: "run.auto_detachable()" }, (update) => updates.push(update));
		await waitFor(
			() => updates.some((update) => update.details.type === "status"),
			"Pyrun progress before auto-detach",
		);
		const result = await resultPromise;
		const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(resultText).toContain("Pyrun evaluation moved to background as job");
		expect(result.details?.backgroundJobId).toBeDefined();

		const [job] = store.listAgents();
		expect(job).toMatchObject({ agentType: "background", displayName: "Pyrun evaluation", lifecycle: "running" });
		await waitFor(() => store.getAgent(job.id)?.lifecycle === "completed", "auto-detached Pyrun completion");
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
				setTimeout(() => reject(new Error("foreground Pyrun remained queued")), 200),
			),
		]);

		expect(foregroundResult.details.value).toBe("");
		const [job] = store.listAgents();
		expect(job.lifecycle).toBe("running");
		await waitFor(() => store.getAgent(job.id)?.lifecycle === "completed", "detached Pyrun completion");
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

		const [job] = store.listAgents();
		expect(job).toMatchObject({ agentType: "background", displayName: "Pyrun evaluation", lifecycle: "running" });
		const [runningArtifact] = store.listArtifacts(job.id);
		expect(runningArtifact).toMatchObject({ kind: "log", title: "Pyrun output" });
		await waitFor(() => store.getAgent(job.id)?.lifecycle === "completed", "detached Pyrun completion");
		expect(store.getAgent(job.id)?.result?.summary).toContain("Pyrun evaluation completed");
		const [artifact] = store.listArtifacts(job.id);
		expect(store.listArtifacts(job.id)).toHaveLength(1);
		expect(artifact.id).toBe(runningArtifact.id);
		expect(artifact).toMatchObject({ kind: "log", title: "Pyrun output" });
		expect(artifact.path && existsSync(artifact.path)).toBe(true);
		expect(artifact.path ? stripAnsi(readFileSync(artifact.path, "utf8")) : "").toContain("detached-done");
		expect(artifact.path ? stripAnsi(readFileSync(artifact.path, "utf8")) : "").not.toContain("Result:");
	});

	it("marks detached Pyrun evaluation errors as failed jobs", async () => {
		const store = new MultiAgentStore({ now: () => "2026-07-05T00:00:00.000Z" });
		const detachRegistry = new ToolDetachRegistry();
		const harness = createPyrunHarness({ backgroundJobs: { store }, detachRegistry });
		const updates: Array<AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>> = [];

		const resultPromise = harness.evaluate({ code: "run.detached_error()" }, (update) => updates.push(update));
		await waitFor(
			() => updates.some((update) => update.details.type === "status"),
			"Pyrun error progress before detach",
		);
		expect(detachRegistry.detachRunning()).toBe(true);
		await resultPromise;

		const [job] = store.listAgents();
		await waitFor(() => store.getAgent(job.id)?.lifecycle === "failed", "detached Pyrun failure");
		expect(store.getAgent(job.id)?.result?.summary).toContain("Pyrun evaluation failed");
	});

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
		expect(updates.map((update) => update.details)).toEqual([
			{ type: "running", executed: "run.never()" },
			{ type: "status", message: "still running" },
		]);
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
