import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderServer } from "./headless-pi.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

async function connect(socketPath: string): Promise<Socket> {
	const socket = createConnection(socketPath);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	return socket;
}

describe("headless provider server", () => {
	it("discards a crashed process's partial request instead of prefixing its replacement's request", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-provider-server-"));
		tempDirs.push(tempDir);
		const socketPath = join(tempDir, "provider.sock");
		const recorded: unknown[] = [];
		const provider = await createProviderServer(socketPath, (request) => recorded.push(request));
		try {
			const crashed = await connect(socketPath);
			crashed.write('{"type":"request","id":"lost","messages":[{"role":"user","content":"trunc');
			await new Promise<void>((resolve) => crashed.end(() => resolve()));
			crashed.destroy();

			const replacement = await connect(socketPath);
			const request = { type: "request", id: "after-restart", messages: [] };
			replacement.write(`${JSON.stringify(request)}\n`);
			await expect.poll(() => recorded).toEqual([request]);
			replacement.destroy();
		} finally {
			await new Promise((resolve) => provider.server.close(resolve));
		}
	});
});
