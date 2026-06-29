import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import hostrunExtension, { type HostrunExtensionOptions } from "../extensions/hostrun/src/index.ts";
import { resolveHostrunRunnerOptions } from "../extensions/hostrun/src/runner.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

interface HostrunEvalParams {
	code: string;
	session_id?: string;
}

interface HostrunPiCapabilitySnapshot {
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

interface HostrunEvalDetails {
	approval?: {
		args: unknown;
		id: string;
		summary: string;
		tool: string;
	};
	console?: Array<{
		level: string;
		message: string;
	}>;
	error?: string;
	executed?: string;
	type: "completed" | "needs_approval";
	value?: unknown;
}

interface HostrunProgressDetails {
	executed?: string;
	message?: string;
	type: string;
}

type HostrunTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: HostrunEvalParams,
		signal: AbortSignal | undefined,
		onUpdate: ((result: AgentToolResult<HostrunEvalDetails | HostrunProgressDetails>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<HostrunEvalDetails>>;
};

function createHostrunHarness(options: HostrunExtensionOptions = {}) {
	let hostrunTool: HostrunTool | undefined;
	let hostrunDefinition: ToolDefinition | undefined;
	const compactRequests: unknown[] = [];
	const enqueuedMessages: Array<{ content: unknown; options: unknown }> = [];
	const restartRequests: unknown[] = [];

	const pi = {
		registerTool(tool: ToolDefinition) {
			if (tool.name === "hostrun_eval") {
				hostrunDefinition = tool;
				hostrunTool = tool as unknown as HostrunTool;
			}
		},
		sendUserMessage(content: unknown, messageOptions: unknown) {
			enqueuedMessages.push({ content, options: messageOptions });
		},
	} as unknown as ExtensionAPI;

	hostrunExtension(pi, options);

	if (!hostrunTool) {
		throw new Error("hostrun_eval was not registered");
	}

	const registeredHostrunTool = hostrunTool;
	const ctx = {
		cwd: process.cwd(),
		footerData: {
			getAvailableProviderCount: () => 3,
			getExtensionStatuses: () =>
				new Map([
					["hostrun", "ready"],
					["agent", "idle"],
				]),
			getGitBranch: () => "feat/hostrun-pi",
			onBranchChange: () => () => {},
		},
		compact: (options: unknown) => {
			compactRequests.push(options);
		},
		getContextUsage: () => ({
			contextWindow: 200000,
			percent: 12.5,
			tokens: 25000,
		}),
		hasUI: false,
		mode: "tui",
		model: { id: "faux/model" },
		restart: async (options: unknown) => {
			restartRequests.push(options);
		},
		sessionManager: {
			getCwd: () => "/repo/project",
			getSessionName: () => "hostrun work",
		},
		ui: {
			confirm: async () => false,
		},
	} as unknown as ExtensionContext;

	return {
		compactRequests,
		enqueuedMessages,
		restartRequests,
		toolDefinition: hostrunDefinition,
		evaluate: (
			params: HostrunEvalParams,
			onUpdate?: (result: AgentToolResult<HostrunEvalDetails | HostrunProgressDetails>) => void,
			signal?: AbortSignal,
		) => registeredHostrunTool.execute("hostrun-test-call", params, signal, onUpdate, ctx),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

function writeFakeHostrunRunner(tempDir: string): string {
	const runnerPath = join(tempDir, "fake-hostrun-runner.mjs");
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
  if (request.code === "ctx.count = 41; ctx.count;") {
    sessionValues.set(sessionId, 41);
    return { type: "completed", executed: request.code, value: 41 };
  }
  if (request.code === "ctx.count += 1; ctx.count;") {
    const next = (sessionValues.get(sessionId) ?? 0) + 1;
    sessionValues.set(sessionId, next);
    return { type: "completed", executed: request.code, value: next };
  }
  if (request.code === "console.log('hello'); 1 + 1") {
    return {
      type: "completed",
      executed: request.code,
      console: [{ level: "log", message: "hello" }],
      value: 2
    };
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
  if (request.code === "run.longTask()") {
    process.stdout.write(JSON.stringify({ type: "status", message: "starting long task" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "progress", message: "halfway done" }) + "\\n");
    return { type: "completed", executed: request.code, value: "done" };
  }
  if (request.code === "run.never()") {
    process.stdout.write(JSON.stringify({ type: "status", message: "still running" }) + "\\n");
    return new Promise(() => {});
  }
  if (request.code === "throw new Error('boom')") {
    throw new Error("boom");
  }
  if (request.code === "quickjs.internal_error") {
    return { type: "error", error: "Exception generated by QuickJS" };
  }
  if (request.code === "pi.footer.snapshot()") {
    return { type: "completed", executed: request.code, value: request.pi.footer };
  }
  if (request.code === "pi.agents.spawn({ prompt: 'inspect X' })") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "agents.spawn", params: { prompt: "inspect X" } }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.agents.wait('agent-1')") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "agents.wait", params: { agentId: "agent-1" } }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.agents.list({ activeOnly: true })") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "agents.list", params: { activeOnly: true } }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.messages.enqueue({ message: 'next', deliverAs: 'followUp' })") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "messages.enqueue", params: { message: "next", deliverAs: "followUp" } }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.compact({ customInstructions: 'preserve IDs' })") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "compact", params: { customInstructions: "preserve IDs" } }) + "\\n");
    const response = await readNextResponse();
    return { type: "completed", executed: request.code, value: response.result };
  }
  if (request.code === "pi.restart({ notice: 'from hostrun' })") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "restart", params: { notice: "from hostrun" } }) + "\\n");
    const response = await readNextResponse();
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

describe("hostrun extension", () => {
	let previousRunnerCommand: string | undefined;
	let previousRunnerArgs: string | undefined;
	let tempDir: string;

	beforeEach(() => {
		initTheme("dark");
		previousRunnerCommand = process.env.PI_HOSTRUN_RUNNER_COMMAND;
		previousRunnerArgs = process.env.PI_HOSTRUN_RUNNER_ARGS;
		tempDir = mkdtempSync(join(tmpdir(), "pi-hostrun-test-"));
		process.env.PI_HOSTRUN_RUNNER_COMMAND = process.execPath;
		process.env.PI_HOSTRUN_RUNNER_ARGS = JSON.stringify([writeFakeHostrunRunner(tempDir)]);
	});

	afterEach(() => {
		if (previousRunnerCommand === undefined) {
			delete process.env.PI_HOSTRUN_RUNNER_COMMAND;
		} else {
			process.env.PI_HOSTRUN_RUNNER_COMMAND = previousRunnerCommand;
		}
		if (previousRunnerArgs === undefined) {
			delete process.env.PI_HOSTRUN_RUNNER_ARGS;
		} else {
			process.env.PI_HOSTRUN_RUNNER_ARGS = previousRunnerArgs;
		}
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("registers hostrun_eval as a Pi adapter for the canonical Hostrun runner", () => {
		const harness = createHostrunHarness();

		expect(harness.toolDefinition?.name).toBe("hostrun_eval");
		expect(harness.toolDefinition?.approvalRequired).toBe(true);
		expect(harness.toolDefinition?.description).toContain("canonical Hostrun runtime");
		expect(harness.toolDefinition?.promptGuidelines?.join("\n")).toContain("Do not use MCP");
		expect(harness.toolDefinition?.promptGuidelines?.join("\n")).toContain("pi.compact");
		expect(harness.toolDefinition?.promptGuidelines?.join("\n")).toContain("pi.restart");
	});

	it("renders only the Hostrun title before execution starts", () => {
		const harness = createHostrunHarness();
		const component = new ToolExecutionComponent(
			"hostrun_eval",
			"hostrun-render-test-call",
			{ code: "run.sleep('10')" },
			{},
			harness.toolDefinition,
			createFakeTui(),
			process.cwd(),
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("hostrun_eval");
		expect(rendered).not.toContain("run.sleep('10')");
	});

	it("renders the Hostrun code from a pending update when call args are not available", () => {
		const harness = createHostrunHarness();
		const component = new ToolExecutionComponent(
			"hostrun_eval",
			"hostrun-render-test-call",
			{},
			{},
			harness.toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: 'run.sleep("10")' }],
				details: { executed: 'run.sleep("10")', type: "running" },
				isError: false,
			},
			true,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("hostrun_eval");
		expect(rendered).toContain('run.sleep("10")');
	});

	it("syntax-colors Hostrun JavaScript in the interactive result row", () => {
		const harness = createHostrunHarness();
		const component = new ToolExecutionComponent(
			"hostrun_eval",
			"hostrun-render-test-call",
			{},
			{},
			harness.toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [
					{
						type: "text",
						text: 'const value = run.sleep("10");\n\nSession: default\nResult: {"success":true}',
					},
				],
				details: { executed: 'const value = run.sleep("10");', type: "completed" },
				isError: false,
			},
			false,
		);

		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("\x1b[");
		expect(stripAnsi(rendered)).toContain('const value = run.sleep("10");');
		expect(stripAnsi(rendered)).toContain("Session: default");
	});

	it("renders Hostrun errors with source and context instead of a generic error row", () => {
		const harness = createHostrunHarness();
		const component = new ToolExecutionComponent(
			"hostrun_eval",
			"hostrun-render-test-call",
			{},
			{},
			harness.toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "Hostrun runner failed: error" }],
				details: { executed: "run.fails()", error: "Hostrun runner failed: error", type: "completed" },
				isError: true,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("run.fails()");
		expect(rendered).toContain("Error: Hostrun runner failed: error");
		expect(rendered).not.toMatch(/^hostrun_eval\s+error$/);
	});

	it("uses the installed cargo hostrun-jsonl when local debug runner is missing", () => {
		const options = resolveHostrunRunnerOptions({
			env: {},
			exists: (path) => path === "/home/osso/.cargo/bin/hostrun-jsonl",
			homeDir: "/home/osso",
		});

		expect(options).toEqual({
			args: ["--serve"],
			command: "/home/osso/.cargo/bin/hostrun-jsonl",
		});
	});

	it("delegates evaluation to the canonical Hostrun runner process", async () => {
		const harness = createHostrunHarness();

		const result = await harness.evaluate({ code: "console.log('hello'); 1 + 1" });

		expect(result.details).toEqual({
			console: [{ level: "log", message: "hello" }],
			executed: "console.log('hello'); 1 + 1",
			type: "completed",
			value: 2,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("console.log('hello'); 1 + 1");
		expect(text).not.toContain("Executed code:");
		expect(text).toContain("Result: 2");
		expect(text).toContain("hello");
	});

	it("keeps Hostrun session state in the runner instead of Pi-local QuickJS", async () => {
		const harness = createHostrunHarness();

		const first = await harness.evaluate({ code: "ctx.count = 41; ctx.count;", session_id: "session-1" });
		const second = await harness.evaluate({ code: "ctx.count += 1; ctx.count;", session_id: "session-1" });

		expect(first.details.value).toBe(41);
		expect(second.details.value).toBe(42);
	});

	it("returns canonical Hostrun approval requests without executing Pi-local helpers", async () => {
		const harness = createHostrunHarness();

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

	it("streams canonical Hostrun in-progress output before the completed result", async () => {
		const harness = createHostrunHarness();
		const updates: Array<AgentToolResult<HostrunEvalDetails | HostrunProgressDetails>> = [];

		const result = await harness.evaluate({ code: "run.longTask()" }, (update) => updates.push(update));

		expect(updates.map((update) => update.details)).toEqual([
			{ type: "running", executed: "run.longTask()" },
			{ type: "status", message: "starting long task" },
			{ type: "progress", message: "halfway done" },
		]);
		expect(updates.map((update) => (update.content[0]?.type === "text" ? update.content[0].text : ""))).toEqual([
			"run.longTask()",
			"starting long task",
			"halfway done",
		]);
		expect(result.details).toEqual({
			executed: "run.longTask()",
			type: "completed",
			value: "done",
		});
	});

	it("marks canonical Hostrun eval errors as final tool errors", async () => {
		const harness = createHostrunHarness();

		const result = await harness.evaluate({ code: "throw new Error('boom')" });

		expect(result.isError).toBe(true);
		expect(result.details).toEqual({
			error: "boom",
			executed: "throw new Error('boom')",
			type: "completed",
		});
		expect(result.content[0]).toEqual({
			type: "text",
			text: "throw new Error('boom')\n\nSession: default\nError: boom",
		});
	});

	it("settles canonical Hostrun type:error messages as final tool errors", async () => {
		const harness = createHostrunHarness();

		const result = await Promise.race([
			harness.evaluate({ code: "quickjs.internal_error" }),
			new Promise((_, reject) => setTimeout(() => reject(new Error("Hostrun type:error did not settle")), 500)),
		]);

		expect(result).toMatchObject({
			details: { error: "Exception generated by QuickJS", type: "error" },
			isError: true,
		});
	});

	it("aborts an in-progress Hostrun evaluation when the agent signal is aborted", async () => {
		const harness = createHostrunHarness();
		const controller = new AbortController();
		const updates: Array<AgentToolResult<HostrunEvalDetails | HostrunProgressDetails>> = [];
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
				new Promise((_, reject) => setTimeout(() => reject(new Error("Hostrun abort did not settle")), 500)),
			]),
		).rejects.toThrow("Hostrun evaluation aborted");
		expect(updates.map((update) => update.details)).toEqual([
			{ type: "running", executed: "run.never()" },
			{ type: "status", message: "still running" },
		]);
	});

	it("sends Pi footer snapshot data to the Hostrun runner", async () => {
		const harness = createHostrunHarness();

		const result = await harness.evaluate({ code: "pi.footer.snapshot()" });

		expect(result.details.value).toEqual({
			availableProviderCount: 3,
			branch: "feat/hostrun-pi",
			contextUsage: {
				contextWindow: 200000,
				percent: 12.5,
				tokens: 25000,
			},
			cwd: "/repo/project",
			extensionStatuses: {
				agent: "idle",
				hostrun: "ready",
			},
			model: "faux/model",
			sessionName: "hostrun work",
		} satisfies HostrunPiCapabilitySnapshot["footer"]);
	});

	it("responds to Hostrun pi.agents.spawn requests through configured handlers", async () => {
		const requests: Array<{ method: string; params: unknown }> = [];
		const harness = createHostrunHarness({
			piRequestHandlers: [
				(request) => {
					requests.push(request);
					return { agent: { id: "agent-1" }, dispatched: true, prompt: "inspect X" };
				},
			],
		});

		const result = await harness.evaluate({ code: "pi.agents.spawn({ prompt: 'inspect X' })" });

		expect(requests).toEqual([{ method: "agents.spawn", params: { prompt: "inspect X" } }]);
		expect(result.details.value).toEqual({ agent: { id: "agent-1" }, dispatched: true, prompt: "inspect X" });
	});

	it("responds to Hostrun pi.agents.wait requests through configured handlers", async () => {
		const harness = createHostrunHarness({
			piRequestHandlers: [
				(request) => {
					if (request.method !== "agents.wait") return undefined;
					return { agent: { id: "agent-1", lifecycle: "completed" }, terminal: true };
				},
			],
		});

		const result = await harness.evaluate({ code: "pi.agents.wait('agent-1')" });

		expect(result.details.value).toEqual({ agent: { id: "agent-1", lifecycle: "completed" }, terminal: true });
	});

	it("responds to Hostrun pi.agents.list requests through configured handlers", async () => {
		const harness = createHostrunHarness({
			piRequestHandlers: [
				(request) => {
					if (request.method !== "agents.list") return undefined;
					return { activeCount: 1, agents: [{ id: "agent-1", lifecycle: "running" }] };
				},
			],
		});

		const result = await harness.evaluate({ code: "pi.agents.list({ activeOnly: true })" });

		expect(result.details.value).toEqual({ activeCount: 1, agents: [{ id: "agent-1", lifecycle: "running" }] });
	});

	it("enqueues user messages from Hostrun pi.messages.enqueue", async () => {
		const harness = createHostrunHarness();

		const result = await harness.evaluate({
			code: "pi.messages.enqueue({ message: 'next', deliverAs: 'followUp' })",
		});

		expect(result.details.value).toEqual({ enqueued: true });
		expect(harness.enqueuedMessages).toEqual([{ content: "next", options: { deliverAs: "followUp" } }]);
	});

	it("triggers Pi compaction from Hostrun pi.compact", async () => {
		const harness = createHostrunHarness();

		const result = await harness.evaluate({
			code: "pi.compact({ customInstructions: 'preserve IDs' })",
		});

		expect(result.details.value).toEqual({ started: true });
		expect(harness.compactRequests).toEqual([{ customInstructions: "preserve IDs" }]);
	});

	it("restarts Pi from Hostrun pi.restart", async () => {
		const harness = createHostrunHarness();

		const result = await harness.evaluate({
			code: "pi.restart({ notice: 'from hostrun' })",
		});

		expect(result.details.value).toEqual({ started: true });
		expect(harness.restartRequests).toEqual([{ notice: "from hostrun" }]);
	});
});
