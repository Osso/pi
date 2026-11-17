import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { type HeadlessLlmRequest, type HeadlessPi, withHeadlessPi } from "../headless-pi.ts";

// In a persisted session every pyrun_eval ran in a fresh Python, so `session_id` could not keep `ctx`, and
// Python ran in the evaluation's artifact directory instead of the session cwd. Calls without a
// `session_id` stay fresh and parallel; a named session keeps one Python, also across restarts.
const PROBE = [
	"import os",
	"ctx.calls = getattr(ctx, 'calls', 0) + 1",
	'print(f"probe calls={ctx.calls} cwd={os.getcwd()} parent={os.getppid()}")',
].join("\n");

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function callPyrun(
	pi: HeadlessPi,
	request: HeadlessLlmRequest,
	params: { code: string; session_id?: string },
): Promise<{ next: HeadlessLlmRequest; text: string }> {
	pi.respondToLlmRequest(
		request.id,
		fauxAssistantMessage(fauxToolCall("pyrun_eval", params), { stopReason: "toolUse" }),
	);
	const next = await pi.waitForLlmRequest((candidate) => candidate.agentId === null && candidate.id !== request.id);
	const results = next.messages.filter((message) => message.role === "toolResult");
	return { next, text: JSON.stringify(results.at(-1)) };
}

async function runProbe(pi: HeadlessPi, request: HeadlessLlmRequest, sessionId?: string) {
	const { next, text } = await callPyrun(pi, request, { code: PROBE, session_id: sessionId });
	const line = text.match(/probe calls=\d+ cwd=\S+ parent=\d+/)?.[0];
	if (!line) throw new Error(`Pyrun probe output missing: ${text}`);
	return { line, next };
}

describe("Pyrun session context", () => {
	it("keeps a named session's ctx across calls and a restart, and stops with its Pi process", async () => {
		let proxyPid = 0;
		await withHeadlessPi(async (pi) => {
			const cwd = pi.paths.workspaceDir;
			await pi.send({ type: "prompt", message: "Probe Pyrun state" });
			const first = await runProbe(pi, await pi.waitForLlmRequest((request) => request.agentId === null), "work");
			expect(first.line).toMatch(new RegExp(`^probe calls=1 cwd=${cwd} parent=\\d+$`));
			proxyPid = Number(first.line.split("parent=")[1]);

			const unnamed = await runProbe(pi, first.next);
			expect(unnamed.line).toMatch(new RegExp(`^probe calls=1 cwd=${cwd} parent=\\d+$`));
			expect(unnamed.line).not.toContain(`parent=${proxyPid}`);

			const second = await runProbe(pi, unnamed.next, "work");
			expect(second.line).toBe(`probe calls=2 cwd=${cwd} parent=${proxyPid}`);

			pi.respondToLlmRequest(
				second.next.id,
				fauxAssistantMessage(fauxToolCall("restart_self", {}), { stopReason: "toolUse" }),
			);
			const restored = await pi.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== second.next.id,
			);
			const third = await runProbe(pi, restored, "work");
			expect(third.line).toBe(`probe calls=3 cwd=${cwd} parent=${proxyPid}`);
			expect(isAlive(proxyPid)).toBe(true);
			await pi.crash();
		});
		await vi.waitFor(() => expect(isAlive(proxyPid)).toBe(false), { interval: 100, timeout: 10_000 });
	}, 60_000);

	it("stops an idle named session while its Pi process keeps running", async () => {
		await withHeadlessPi(
			async (pi) => {
				await pi.send({ type: "prompt", message: "Probe an idle Pyrun session" });
				const first = await runProbe(pi, await pi.waitForLlmRequest((request) => request.agentId === null), "work");
				const proxyPid = Number(first.line.split("parent=")[1]);

				await vi.waitFor(() => expect(isAlive(proxyPid)).toBe(false), { interval: 100, timeout: 15_000 });
				const after = await runProbe(pi, first.next, "work");
				expect(after.line).toMatch(/^probe calls=1 /);
				expect(after.line).not.toContain(`parent=${proxyPid}`);
				await pi.crash();
			},
			{ env: { PI_PYRUN_SESSION_IDLE_MS: "1000" } },
		);
	}, 60_000);

	it("fails a call to a busy named session at once while unnamed calls still run", async () => {
		await withHeadlessPi(
			async (pi) => {
				const startedPath = join(pi.paths.workspaceDir, "long-started");
				const releasePath = join(pi.paths.workspaceDir, "long-release");
				await pi.send({ type: "prompt", message: "Probe a busy Pyrun session" });
				const first = await runProbe(pi, await pi.waitForLlmRequest((request) => request.agentId === null), "work");
				expect(first.line).toMatch(/^probe calls=1 /);

				const longCode = [
					"from pathlib import Path",
					"import time",
					`Path(${JSON.stringify(startedPath)}).write_text("started")`,
					`while not Path(${JSON.stringify(releasePath)}).exists(): time.sleep(0.05)`,
				].join("\n");
				const detached = await callPyrun(pi, first.next, { code: longCode, session_id: "work" });
				await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true));

				const busy = await callPyrun(pi, detached.next, { code: PROBE, session_id: "work" });
				expect(busy.text).toContain("Pyrun session work is busy with another evaluation");
				const unnamed = await runProbe(pi, busy.next);
				expect(unnamed.line).toMatch(/^probe calls=1 /);

				writeFileSync(releasePath, "release");
				await pi.waitForAgent(
					(agent) => agent.displayName === "Pyrun evaluation" && agent.lifecycle === "completed",
				);
				const after = await runProbe(pi, unnamed.next, "work");
				expect(after.line).toMatch(/^probe calls=2 /);
				await pi.crash();
			},
			{ autoDetachTools: true, env: { PI_HEADLESS_TOOL_AUTO_DETACH_MS: "1000" } },
		);
	}, 60_000);
});
