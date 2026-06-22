import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import hostrunExtension from "../extensions/hostrun/src/index.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";

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

type HostrunTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: HostrunEvalParams,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
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
		evaluate: (params: HostrunEvalParams) =>
			registeredHostrunTool.execute("hostrun-test-call", params, undefined, undefined, ctx),
	};
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
});
