import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DebugReplServer, getDebugSocketPath } from "../src/core/debug-repl.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

function createAgentDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-debug-repl-"));
	temporaryDirectories.push(directory);
	return directory;
}

it("evaluates expressions against the current runtime instead of a captured session", async () => {
	const agentDir = createAgentDir();
	let runtime = { session: { sessionId: "first" } };
	const server = new DebugReplServer({ agentDir, getRuntime: () => runtime });
	await server.enable("first");

	const first = await server.evaluateForTest("pi.session.sessionId");
	runtime = { session: { sessionId: "second" } };
	const second = await server.evaluateForTest("pi.session.sessionId");
	const awaited = await server.evaluateForTest("await Promise.resolve(3)");

	expect(first).toBe("first");
	expect(second).toBe("second");
	expect(awaited).toBe(3);
	expect(server.socketPath).toBe(getDebugSocketPath(agentDir, process.pid));
	await server.disable();
});

it("records promise outcomes and current session identity without expression or result contents", async () => {
	const agentDir = createAgentDir();
	let runtime = { session: { sessionId: "first", secret: "returned-secret" } };
	const server = new DebugReplServer({ agentDir, getRuntime: () => runtime });
	await server.enable("first");

	await server.evaluateForTest("pi.session.secret", 4242);
	runtime = { session: { sessionId: "second", secret: "returned-secret" } };
	await expect(server.evaluateForTest("Promise.reject(new Error('rejected-secret'))", 4242)).rejects.toThrow(
		"rejected-secret",
	);
	await server.disable();

	const audit = readFileSync(join(agentDir, "debug", "audit.jsonl"), "utf8");
	const records = audit
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	expect(records).toMatchObject([
		{ claimedClientPid: 4242, sessionId: "first", status: "success" },
		{ claimedClientPid: 4242, sessionId: "second", status: "error" },
	]);
	expect(audit).not.toContain("pi.session.secret");
	expect(audit).not.toContain("returned-secret");
	expect(audit).not.toContain("rejected-secret");
});
