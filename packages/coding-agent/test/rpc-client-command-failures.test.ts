import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

// A stand-in RPC server that rejects every command the way rpc-mode reports a failed command.
const REJECTING_SERVER = `
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
	const command = JSON.parse(line);
	const response = { type: "response", id: command.id, command: command.type, success: false, error: "rejected " + command.type };
	process.stdout.write(JSON.stringify(response) + "\\n");
}
`;

const DELAYED_REJECTING_SERVER = `
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
	const command = JSON.parse(line);
	const response = { type: "response", id: command.id, command: command.type, success: false, error: "rejected " + command.type };
	setTimeout(() => process.stdout.write(JSON.stringify(response) + "\\n"), Number(process.env.SERVER_DELAY_MS));
}
`;

const SUCCESS_WITHOUT_SETTLED_SERVER = `
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
	const command = JSON.parse(line);
	const response = { type: "response", id: command.id, command: command.type, success: true };
	process.stdout.write(JSON.stringify(response) + "\\n");
}
`;

let client: RpcClient | undefined;
let tempDir: string | undefined;

afterEach(async () => {
	await client?.stop();
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	client = undefined;
	tempDir = undefined;
});

async function startClient(server: string, env?: Record<string, string>): Promise<RpcClient> {
	tempDir = mkdtempSync(join(tmpdir(), "pi-rpc-client-failures-"));
	const cliPath = join(tempDir, "server.mjs");
	writeFileSync(cliPath, server);
	client = new RpcClient({ cliPath, env });
	await client.start();
	return client;
}

async function startRejectingClient(): Promise<RpcClient> {
	return startClient(REJECTING_SERVER);
}

describe("RpcClient command failures", () => {
	test.each([
		["prompt", (rpc: RpcClient) => rpc.prompt("/no-such-command")],
		["steer", (rpc: RpcClient) => rpc.steer("hi")],
		["follow_up", (rpc: RpcClient) => rpc.followUp("hi")],
		["abort", (rpc: RpcClient) => rpc.abort()],
		["interrupt", (rpc: RpcClient) => rpc.interrupt()],
		["set_thinking_level", (rpc: RpcClient) => rpc.setThinkingLevel("high")],
		["set_steering_mode", (rpc: RpcClient) => rpc.setSteeringMode("all")],
		["set_follow_up_mode", (rpc: RpcClient) => rpc.setFollowUpMode("all")],
		["set_auto_compaction", (rpc: RpcClient) => rpc.setAutoCompaction(true)],
		["set_auto_retry", (rpc: RpcClient) => rpc.setAutoRetry(true)],
		["abort_retry", (rpc: RpcClient) => rpc.abortRetry()],
		["abort_bash", (rpc: RpcClient) => rpc.abortBash()],
		["set_session_name", (rpc: RpcClient) => rpc.setSessionName("   ")],
	])("rejects when the server rejects %s", async (command, call) => {
		const rpc = await startRejectingClient();
		await expect(call(rpc)).rejects.toThrow(`rejected ${command}`);
	});

	test("promptAndWait preserves the prompt error when the collector times out first", async () => {
		const rpc = await startClient(DELAYED_REJECTING_SERVER, { SERVER_DELAY_MS: "100" });
		await expect(rpc.promptAndWait("/no-such-command", undefined, 20)).rejects.toThrow("rejected prompt");
	});

	test("promptAndWait cancels collection after a prompt error", async () => {
		const rpc = await startClient(DELAYED_REJECTING_SERVER, { SERVER_DELAY_MS: "20" });
		await expect(rpc.promptAndWait("/no-such-command", undefined, 250)).rejects.toThrow("rejected prompt");
		// Wait beyond the collector deadline; its cancelled timeout must not reject later.
		await new Promise((resolve) => setTimeout(resolve, 300));
	});

	test("promptAndWait surfaces the collector timeout after a successful prompt", async () => {
		const rpc = await startClient(SUCCESS_WITHOUT_SETTLED_SERVER);
		await expect(rpc.promptAndWait("hello", undefined, 20)).rejects.toThrow("Timeout collecting events");
	});
});
