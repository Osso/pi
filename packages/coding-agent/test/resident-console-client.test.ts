import { mkdtempSync } from "node:fs";
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
		service: "supervisor",
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
			service: "supervisor",
			getSnapshot: snapshot,
			enqueuePrompt: () => {},
			subscribe: () => () => {},
		});
		resources.push(server);
		await server.start();

		const client = await ResidentConsoleClient.connect({ socketPath: server.socketPath, service: "supervisor" });
		resources.push(client);

		expect(client.snapshot).toEqual(snapshot());
	});

	it("rejects identities without explicit readiness", async () => {
		const invalidSnapshot = snapshot();
		if (!invalidSnapshot.identity) throw new Error("expected resident identity");
		delete (invalidSnapshot.identity as { ready?: true }).ready;
		const server = new ResidentConsoleServer({
			socketPath: socketPath(),
			service: "supervisor",
			getSnapshot: () => invalidSnapshot,
			enqueuePrompt: () => {},
			subscribe: () => () => {},
		});
		resources.push(server);
		await server.start();

		await expect(probeResidentConsole({ socketPath: server.socketPath, service: "supervisor" })).rejects.toThrow(
			"Invalid resident console identity",
		);
	});

	it("probes identity without claiming the writable console owner", async () => {
		let subscriptions = 0;
		const prompts: string[] = [];
		const server = new ResidentConsoleServer({
			socketPath: socketPath(),
			service: "supervisor",
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
		const client = await ResidentConsoleClient.connect({ socketPath: server.socketPath, service: "supervisor" });
		resources.push(client);

		await expect(probeResidentConsole({ socketPath: server.socketPath, service: "supervisor" })).resolves.toEqual(
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
			service: "supervisor",
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
			service: "supervisor",
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
			service: "supervisor",
			getSnapshot: snapshot,
			enqueuePrompt: () => {},
			subscribe: () => () => {},
		});
		resources.push(server);
		await server.start();
		const firstClient = await ResidentConsoleClient.connect({
			socketPath: server.socketPath,
			service: "supervisor",
		});
		resources.push(firstClient);
		const firstClientDisconnected = new Promise<void>((resolve) => firstClient.onDisconnect(() => resolve()));

		const secondClient = await ResidentConsoleClient.connect({
			socketPath: server.socketPath,
			service: "supervisor",
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
});
