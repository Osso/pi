import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

type RpcClientProcess = {
	pid?: number;
	kill: (signal?: NodeJS.Signals | number) => boolean;
	once: (event: "exit", listener: () => void) => unknown;
};

type RpcClientInternals = {
	process: RpcClientProcess | null;
};

function createChildScript(contents: (dir: string) => string): { path: string; readyPath: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-exit-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	const readyPath = join(dir, "ready");
	writeFileSync(path, contents(dir));
	return { path, readyPath };
}

function writeChildScript(contents: string): string {
	return createChildScript(() => contents).path;
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient child process failures", () => {
	test("reports an explicit startup cancellation when stopped during startup", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
`),
		});

		const starting = client.start();
		const startupRejection = expect(starting).rejects.toThrow("RPC client stopped during startup");
		await client.stop();
		await startupRejection;
	});

	test("rejects an in-flight request when the child process exits", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", () => {
	process.exit(43);
});
process.stdin.resume();
`),
		});

		await client.start();

		await expect(client.getCommands()).rejects.toThrow(/Agent process exited \(code=43 signal=null\)/);
	});

	test("rejects an in-flight request when stopped", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
`),
		});
		await client.start();

		const pendingRequest = client.send({ type: "get_commands" });
		const pendingRejection = expect(pendingRequest).rejects.toThrow("RPC client stopped");
		await client.stop();
		await pendingRejection;
	});

	test("rejects commands sent after stop begins", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
`),
		});
		await client.start();

		const stopping = client.stop();
		await expect(client.send({ type: "get_commands" })).rejects.toThrow("RPC client is stopping");
		await stopping;
	});

	test("retains a live child handle when forced termination fails so stop can retry", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
`),
		});
		await client.start();
		const internals = client as unknown as RpcClientInternals;
		const childProcess = internals.process;
		if (!childProcess) throw new Error("expected RPC child process");
		const kill = childProcess.kill.bind(childProcess);
		childProcess.kill = () => true;

		try {
			await expect(client.stop()).rejects.toThrow("RPC child did not exit after SIGKILL");
			expect(internals.process).toBe(childProcess);
			await expect(client.start()).rejects.toThrow("Client already started");
			await expect(client.send({ type: "get_commands" })).rejects.toThrow("Previous RPC stop failed");
		} finally {
			childProcess.kill = kill;
			await client.stop();
		}
		expect(internals.process).toBeNull();
	});

	test("sends SIGKILL after a ready child ignores SIGTERM and waits for its exit", async () => {
		const script = createChildScript(
			(dir) => `
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(join(dir, "ready"))}, "ready");
process.stdin.resume();
setInterval(() => {}, 1000);
`,
		);
		const client = new RpcClient({ cliPath: script.path });
		let childProcess: RpcClientProcess | null = null;
		let kill: RpcClientProcess["kill"] | undefined;
		try {
			await client.start();
			childProcess = (client as unknown as RpcClientInternals).process;
			if (!childProcess?.pid) throw new Error("expected RPC child process");
			await waitForFile(script.readyPath);
			const pid = childProcess.pid;
			kill = childProcess.kill.bind(childProcess);
			const signals: (NodeJS.Signals | number | undefined)[] = [];
			childProcess.kill = (signal) => {
				signals.push(signal);
				return kill?.(signal) ?? false;
			};
			let exited = false;
			childProcess.once("exit", () => {
				exited = true;
			});

			await client.stop();

			expect(exited).toBe(true);
			expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
			expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			if (childProcess && kill) childProcess.kill = kill;
			await client.stop();
		}
	});
});
