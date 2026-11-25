import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
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

function readUntil(socket: Socket, marker: string): Promise<string> {
	return new Promise((resolve) => {
		let output = "";
		const onData = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (!output.includes(marker)) return;
			socket.off("data", onData);
			resolve(output);
		};
		socket.on("data", onData);
	});
}

it("decodes a UTF-8 character split across socket reads", async () => {
	const agentDir = createAgentDir();
	const server = new DebugReplServer({ agentDir, getRuntime: () => ({ session: { sessionId: "first" } }) });
	await server.enable("first");
	const socket = createConnection(server.socketPath);
	try {
		const prompt = readUntil(socket, "pi> ");
		socket.write(`${JSON.stringify({ pid: process.pid, sessionId: "first" })}\n`);
		await prompt;

		const result = readUntil(socket, "pi> ");
		socket.write(Buffer.from([0x27, 0xc3]));
		await new Promise((resolve) => setTimeout(resolve, 50));
		socket.write(Buffer.concat([Buffer.from([0xa9]), Buffer.from("'.codePointAt(0)\n")]));

		expect(await result).toContain("233");
	} finally {
		socket.destroy();
		await server.disable();
	}
});

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

it("runs a submission once when it throws an await-like SyntaxError at runtime", async () => {
	const agentDir = createAgentDir();
	const runtime = { session: { sessionId: "first", counter: 0 } };
	const server = new DebugReplServer({ agentDir, getRuntime: () => runtime });
	await server.enable("first");

	await expect(
		server.evaluateForTest('(() => { pi.session.counter++; throw new SyntaxError("Unexpected reserved word"); })()'),
	).rejects.toThrow("Unexpected reserved word");

	expect(runtime.session.counter).toBe(1);
	await server.disable();
});

it("accepts a trailing semicolon after a top-level await", async () => {
	const agentDir = createAgentDir();
	const server = new DebugReplServer({ agentDir, getRuntime: () => ({ session: { sessionId: "first" } }) });
	await server.enable("first");

	await expect(server.evaluateForTest("await Promise.resolve(4);")).resolves.toBe(4);
	await server.disable();
});
