import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import hostrunExtension from "../extensions/hostrun/src/index.ts";
import { resolveHostrunRunnerOptions } from "../extensions/hostrun/src/runner.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

interface HostrunEvalParams {
	code: string;
	session_id?: string;
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

function createHostrunHarness() {
	let hostrunTool: HostrunTool | undefined;
	let hostrunDefinition: ToolDefinition | undefined;

	const pi = {
		registerTool(tool: ToolDefinition) {
			if (tool.name === "hostrun_eval") {
				hostrunDefinition = tool;
				hostrunTool = tool as unknown as HostrunTool;
			}
		},
	} as unknown as ExtensionAPI;

	hostrunExtension(pi);

	if (!hostrunTool) {
		throw new Error("hostrun_eval was not registered");
	}

	const registeredHostrunTool = hostrunTool;
	const ctx = {
		cwd: process.cwd(),
		hasUI: false,
		mode: "tui",
		ui: {
			confirm: async () => false,
		},
	} as unknown as ExtensionContext;

	return {
		toolDefinition: hostrunDefinition,
		evaluate: (
			params: HostrunEvalParams,
			onUpdate?: (result: AgentToolResult<HostrunEvalDetails | HostrunProgressDetails>) => void,
		) => registeredHostrunTool.execute("hostrun-test-call", params, undefined, onUpdate, ctx),
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

function resultFor(request) {
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
  return { type: "completed", executed: request.code, value: null };
}

for await (const chunk of process.stdin) {
  buffer += String(chunk);
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    process.stdout.write(JSON.stringify(resultFor(JSON.parse(line))) + "\\n");
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
});
