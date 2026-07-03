import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewToolWithClaudeBashHook } from "../extensions/claude-bash-hook/src/index.ts";
import type { ToolCallEvent } from "../src/core/extensions/types.ts";

function makeToolCallEvent(toolName: string, input: Record<string, unknown>): ToolCallEvent {
	return {
		type: "tool_call",
		toolName,
		toolCallId: "test-call",
		bypassPermissions: false,
		input,
	} as ToolCallEvent;
}

function writeFakeHook(tempDir: string): string {
	const hookPath = join(tempDir, "fake-claude-bash-hook.mjs");
	writeFileSync(
		hookPath,
		`#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const payload = JSON.parse(input);
  const code = payload.tool_input?.code;
  const expectedCode = payload.tool_name === "pyrun_eval" ? "print(1 + 1)" : "run.sleep('1')";
  if (!["pyrun_eval", "hostrun_eval"].includes(payload.tool_name) || code !== expectedCode) {
    console.error(JSON.stringify(payload));
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow", permissionDecisionReason: "ok" } }));
});
`,
	);
	chmodSync(hookPath, 0o755);
	return hookPath;
}

describe("claude-bash-hook extension", () => {
	let tempDir: string;
	let previousHook: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-claude-bash-hook-test-"));
		previousHook = process.env.PI_CLAUDE_BASH_HOOK;
		process.env.PI_CLAUDE_BASH_HOOK = writeFakeHook(tempDir);
	});

	afterEach(() => {
		if (previousHook === undefined) {
			delete process.env.PI_CLAUDE_BASH_HOOK;
		} else {
			process.env.PI_CLAUDE_BASH_HOOK = previousHook;
		}
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("reviews pyrun_eval code with claude-bash-hook", async () => {
		const event = makeToolCallEvent("pyrun_eval", { code: "print(1 + 1)" });

		const result = await reviewToolWithClaudeBashHook(event, "/repo");

		expect(result).toEqual({ action: "allow" });
	});

	it("reviews hostrun_eval code with claude-bash-hook", async () => {
		const event = makeToolCallEvent("hostrun_eval", { code: "run.sleep('1')" });

		const result = await reviewToolWithClaudeBashHook(event, "/repo");

		expect(result).toEqual({ action: "allow" });
	});
});
