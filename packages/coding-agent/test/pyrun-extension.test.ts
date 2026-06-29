import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pyrunExtension from "../extensions/pyrun/src/index.ts";
import { resolvePyrunRunnerOptions } from "../extensions/pyrun/src/runner.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

interface PyrunEvalParams {
	code: string;
	session_id?: string;
}

interface PyrunEvalDetails {
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
	type: "completed" | "error" | "needs_approval";
	value?: unknown;
}

interface PyrunProgressDetails {
	executed?: string;
	message?: string;
	type: string;
}

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

function createPyrunHarness() {
	let pyrunTool: PyrunTool | undefined;
	let pyrunDefinition: ToolDefinition | undefined;

	const pi = {
		registerTool(tool: ToolDefinition) {
			if (tool.name === "pyrun_eval") {
				pyrunDefinition = tool;
				pyrunTool = tool as unknown as PyrunTool;
			}
		},
	} as unknown as ExtensionAPI;

	pyrunExtension(pi);

	if (!pyrunTool) {
		throw new Error("pyrun_eval was not registered");
	}

	const registeredPyrunTool = pyrunTool;
	const ctx = {
		cwd: process.cwd(),
		footerData: undefined,
		getContextUsage: () => undefined,
		hasUI: false,
		mode: "tui",
		model: { id: "faux/model" },
		sessionManager: {
			getCwd: () => "/repo/project",
			getSessionName: () => "pyrun work",
		},
		ui: {
			confirm: async () => false,
		},
	} as unknown as ExtensionContext;

	return {
		toolDefinition: pyrunDefinition,
		evaluate: (
			params: PyrunEvalParams,
			onUpdate?: (result: AgentToolResult<PyrunEvalDetails | PyrunProgressDetails>) => void,
			signal?: AbortSignal,
		) => registeredPyrunTool.execute("pyrun-test-call", params, signal, onUpdate, ctx),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

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
      console: [{ level: "stdout", message: "hello" }],
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
  if (request.code === "run.long_task()") {
    process.stdout.write(JSON.stringify({ type: "status", message: "starting long task" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "progress", message: "halfway done" }) + "\\n");
    return { type: "completed", executed: request.code, value: "done" };
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
  return { type: "completed", executed: request.code, value: null };
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

		expect(options).toEqual({ args: ["-m", "pyrun.jsonl"], command: "python" });
	});

	it("uses pyrun-jsonl without args by default", () => {
		const options = resolvePyrunRunnerOptions({ env: {} });

		expect(options).toEqual({ args: [], command: "pyrun-jsonl" });
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
				content: [{ type: "text", text: 'value = run.sleep(10)\n\nSession: default\nResult: {"success":true}' }],
				details: { executed: "value = run.sleep(10)", type: "completed" },
				isError: false,
			},
			false,
		);

		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("\x1b[");
		expect(stripAnsi(rendered)).toContain("value = run.sleep(10)");
		expect(stripAnsi(rendered)).toContain("Session: default");
	});

	it("delegates evaluation to the Pyrun JSONL runner process", async () => {
		const harness = createPyrunHarness();

		const result = await harness.evaluate({ code: "print('hello')\n1 + 1" });

		expect(result.details).toEqual({
			console: [{ level: "stdout", message: "hello" }],
			executed: "print('hello')\n1 + 1",
			type: "completed",
			value: 2,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("print('hello')\n1 + 1");
		expect(text).toContain("Result: 2");
		expect(text).toContain("hello");
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
