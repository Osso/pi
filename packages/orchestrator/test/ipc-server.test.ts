import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSocketPath } from "../src/config.ts";
import type { OrchestratorRequest, OrchestratorResponse } from "../src/ipc/protocol.ts";
import { type IpcRequestHandler, startIpcServer } from "../src/ipc/server.ts";

describe("IPC buffered lines", () => {
	let directory: string;
	let server: Server;
	let client: Socket;
	let responses: unknown[];
	let handledRequests: OrchestratorRequest[];

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "ipc-"));
		vi.stubEnv("PI_ORCHESTRATOR_DIR", directory);
		responses = [];
		handledRequests = [];
		const handleRequest = async (request: OrchestratorRequest): Promise<OrchestratorResponse> => {
			handledRequests.push(request);
			if (request.type === "rpc_stream") {
				return { type: "rpc_ready", ok: true, instance: { id: "test", cwd: "/tmp", status: "online" } };
			}
			return { type: "list_result", ok: true, instances: [] };
		};
		const handler = Object.assign(handleRequest, {
			openRpcStream: (_instanceId: string, onResponse: (response: unknown) => void) => ({
				async handleRequest(command: { id?: string; type: string }) {
					onResponse({ type: "response", id: command.id, command: command.type, success: true });
				},
				close() {},
			}),
		}) as IpcRequestHandler;
		server = await startIpcServer(handler);
		client = createConnection(getSocketPath());
		let buffer = "";
		client.on("data", (chunk) => {
			buffer += chunk.toString();
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				responses.push(JSON.parse(buffer.slice(0, newline)));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
		});
		await once(client, "connect");
	});

	afterEach(async () => {
		client?.destroy();
		if (server) {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	it.each(["", "\n \n"])("drains coalesced stream commands after initial blanks %j", async (prefix) => {
		client.write(
			`${prefix}{"type":"rpc_stream","instanceId":"test"}\n` +
				'{"id":"first","type":"get_state"}\n\n{"id":"second","type":"get_messages"}\n',
		);

		await vi.waitFor(() => {
			expect(responses).toEqual([
				{ type: "rpc_ready", ok: true, instance: { id: "test", cwd: "/tmp", status: "online" } },
				{ type: "response", id: "first", command: "get_state", success: true },
				{ type: "response", id: "second", command: "get_messages", success: true },
			]);
		});
	});

	it("retains an incomplete stream frame until its remaining bytes arrive", async () => {
		client.write('{"type":"rpc_stream","instanceId":"test"}\n{"id":"partial","type":');
		await vi.waitFor(() => expect(responses).toHaveLength(1));
		client.write('"get_state"}\n');
		await vi.waitFor(() => {
			expect(responses[1]).toEqual({ type: "response", id: "partial", command: "get_state", success: true });
		});
	});

	it("ends an ordinary request after one response despite trailing complete requests", async () => {
		const ended = once(client, "end");
		client.write('\n \n{"type":"list"}\n{"type":"list"}\n');
		await ended;
		expect(responses).toEqual([{ type: "list_result", ok: true, instances: [] }]);
		expect(handledRequests).toEqual([{ type: "list" }]);
	});
});
