import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ResidentConsoleClient,
	ResidentConsoleServer,
	type ResidentConsoleSnapshot,
} from "../src/core/resident-console-transport.ts";

const resources: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
	await Promise.all(resources.splice(0).reverse().map((resource) => resource.close()));
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

	it("submits prompts and receives monotonic resident events", async () => {
		let publish: ((event: { type: string }) => void) | undefined;
		const prompts: string[] = [];
		const server = new ResidentConsoleServer({
			socketPath: socketPath(),
			service: "supervisor",
			getSnapshot: snapshot,
			enqueuePrompt: (text) => prompts.push(text),
			subscribe: (listener) => {
				publish = listener;
				return () => { publish = undefined; };
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

	it("fails explicitly when the resident socket is absent", async () => {
		await expect(ResidentConsoleClient.connect({ socketPath: socketPath(), service: "architect" })).rejects.toThrow(
			"Resident console is unavailable",
		);
	});
});
