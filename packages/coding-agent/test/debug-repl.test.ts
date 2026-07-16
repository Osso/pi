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
	await server.enable("supervisor-session");

	const first = await server.evaluateForTest("pi.session.sessionId");
	runtime = { session: { sessionId: "second" } };
	const second = await server.evaluateForTest("pi.session.sessionId");

	expect(first).toBe("first");
	expect(second).toBe("second");
	expect(server.socketPath).toBe(getDebugSocketPath(agentDir, process.pid));
	await server.disable();
});

it("records expression hashes without recording expression or result contents", async () => {
	const agentDir = createAgentDir();
	const server = new DebugReplServer({ agentDir, getRuntime: () => ({ session: { secret: "returned-secret" } }) });
	await server.enable("audit-session");

	await server.evaluateForTest("pi.session.secret", 4242);
	await server.disable();

	const audit = readFileSync(join(agentDir, "debug", "audit.jsonl"), "utf8");
	expect(audit).toContain('"clientPid":4242');
	expect(audit).toContain('"status":"success"');
	expect(audit).not.toContain("pi.session.secret");
	expect(audit).not.toContain("returned-secret");
});
