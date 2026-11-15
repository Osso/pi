import { mkdtempSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	probeResidentConsole,
	ResidentConsoleClient,
	ResidentConsoleServer,
	type ResidentConsoleSnapshot,
} from "../src/core/resident-console-transport.ts";

const resources: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
	await Promise.all(
		resources
			.splice(0)
			.reverse()
			.map((resource) => resource.close()),
	);
});

function socketPath(): string {
	return join(mkdtempSync(join(tmpdir(), "pi-console-client-")), "console.sock");
}

function snapshot(): ResidentConsoleSnapshot<{ value: string }> {
	return {
		service: "architect",
		sessionId: "supervisor",
		cwd: "/resident",
		generation: 9,
		identity: {
			version: "0.80.3",
			pid: 1234,
			executable: "/usr/local/bin/pi",
			entrypoint: "/usr/local/bin/pi",
			instanceId: "service-instance-1",
			managedBy: "pi",
			ready: true,
		},
		branch: [{ value: "existing" }],
	};
}

describe("ResidentConsoleClient", () => {
	it("attaches to the existing resident and receives its full snapshot", async () => {
		const server = new ResidentConsoleServer({
			socketPath: socketPath(),
			service: "architect",
			getSnapshot: snapshot,
			enqueuePrompt: () => {},
			subscribe: () => () => {},
		});
		resources.push(server);
		await server.start();

		const client = await ResidentConsoleClient.connect({ socketPath: server.socketPath, service: "architect" });
		resources.push(client);

		expect(client.snapshot).toEqual(snapshot());
	});

	it("rejects identities without explicit readiness", async () => {
		const invalidSnapshot = snapshot();
		if (!invalidSnapshot.identity) throw new Error("expected resident identity");
		delete (invalidSnapshot.identity as { ready?: true }).ready;
		const server = new ResidentConsoleServer({
			socketPath: socketPath(),
			service: "architect",
			getSnapshot: () => invalidSnapshot,
			enqueuePrompt: () => {},
			subscribe: () => () => {},
		});
		resources.push(server);
		await server.start();

		await expect(probeResidentConsole({ socketPath: server.socketPath, service: "architect" })).rejects.toThrow(
			"Invalid resident console identity",
		);
	});

	it("probes identity without claiming the writable console owner", async () => {
		let subscriptions = 0;
		const prompts: string[] = [];
		const server = new ResidentConsoleServer({
			socketPath: socketPath(),
			service: "architect",
			getSnapshot: snapshot,
			enqueuePrompt: (text) => {
				prompts.push(text);
			},
			subscribe: () => {
				subscriptions += 1;
				return () => {};
			},
		});
		resources.push(server);
		await server.start();
		const client = await ResidentConsoleClient.connect({ socketPath: server.socketPath, service: "architect" });
		resources.push(client);

		await expect(probeResidentConsole({ socketPath: server.socketPath, service: "architect" })).resolves.toEqual(
			snapshot(),
		);
		await client.prompt("prompt-1", "still owner");

		expect(prompts).toEqual(["still owner"]);
		expect(subscriptions).toBe(1);
	});

	it("submits prompts and receives monotonic resident events", async () => {
		let publish: ((event: { type: string }) => void) | undefined;
		const prompts: string[] = [];
		const server = new ResidentConsoleServer({
			socketPath: socketPath(),
			service: "architect",
			getSnapshot: snapshot,
			enqueuePrompt: (text) => {
				prompts.push(text);
			},
			subscribe: (listener) => {
				publish = listener;
				return () => {
					publish = undefined;
				};
			},
		});
		resources.push(server);
		await server.start();
		const client = await ResidentConsoleClient.connect<{ value: string }, { type: string }>({
			socketPath: server.socketPath,
			service: "architect",
		});
		resources.push(client);
		const events: Array<{ sequence: number; event: { type: string } }> = [];
		client.onEvent((event) => events.push(event));

		await client.prompt("prompt-1", "inspect this");
		publish?.({ type: "agent_start" });
		publish?.({ type: "agent_end" });
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(prompts).toEqual(["inspect this"]);
		expect(events).toEqual([
			{ sequence: 1, event: { type: "agent_start" } },
			{ sequence: 2, event: { type: "agent_end" } },
		]);
	});

	it("transfers writable ownership to the newest console client", async () => {
		const server = new ResidentConsoleServer({
			socketPath: socketPath(),
			service: "architect",
			getSnapshot: snapshot,
			enqueuePrompt: () => {},
			subscribe: () => () => {},
		});
		resources.push(server);
		await server.start();
		const firstClient = await ResidentConsoleClient.connect({
			socketPath: server.socketPath,
			service: "architect",
		});
		resources.push(firstClient);
		const firstClientDisconnected = new Promise<void>((resolve) => firstClient.onDisconnect(() => resolve()));

		const secondClient = await ResidentConsoleClient.connect({
			socketPath: server.socketPath,
			service: "architect",
		});
		resources.push(secondClient);

		await firstClientDisconnected;
		expect(secondClient.snapshot).toEqual(snapshot());
		await expect(secondClient.prompt("prompt-2", "new owner")).resolves.toBeUndefined();
	});

	it("fails explicitly when the resident socket is absent", async () => {
		await expect(ResidentConsoleClient.connect({ socketPath: socketPath(), service: "architect" })).rejects.toThrow(
			"Resident console is unavailable",
		);
	});

	it("rejects non-object JSON frames on server and client sockets", async () => {
		const server = new ResidentConsoleServer({
			socketPath: socketPath(),
			service: "architect",
			getSnapshot: snapshot,
			enqueuePrompt: () => {},
			subscribe: () => () => {},
		});
		resources.push(server);
		await server.start();

		const serverError = await new Promise<Record<string, unknown>>((resolve, reject) => {
			const socket = createConnection(server.socketPath);
			let buffer = "";
			socket.on("connect", () => socket.write("null\n"));
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				socket.destroy();
				resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
			});
			socket.on("error", reject);
		});
		expect(serverError).toEqual({
			type: "error",
			code: "invalid_message",
			message: "Invalid resident console message",
		});

		const badClientSocketPath = socketPath();
		const mockServer = createServer((socket) => {
			socket.once("data", () => socket.write("null\n"));
		});
		await new Promise<void>((resolve) => mockServer.listen(badClientSocketPath, resolve));
		try {
			await expect(probeResidentConsole({ socketPath: badClientSocketPath, service: "architect" })).rejects.toThrow(
				"Invalid resident console attach response",
			);
		} finally {
			await new Promise<void>((resolve, reject) => mockServer.close((error) => (error ? reject(error) : resolve())));
		}
	});
});
