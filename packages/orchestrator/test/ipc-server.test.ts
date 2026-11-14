import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSocketPath } from "../src/config.ts";
import { sendIpcRequest } from "../src/ipc/client.ts";
import type { OrchestratorRequest, OrchestratorResponse } from "../src/ipc/protocol.ts";
import { type IpcRequestHandler, startIpcServer } from "../src/ipc/server.ts";

describe("IPC buffered lines", () => {
	let directory: string;
	let server: Server;
	let client: Socket;
	let responses: unknown[];
	let handledRequests: OrchestratorRequest[];
	let streamReadyDelay: Promise<void>;
	let streamMessages: unknown[];

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "ipc-"));
		vi.stubEnv("PI_ORCHESTRATOR_DIR", directory);
		responses = [];
		handledRequests = [];
		streamReadyDelay = Promise.resolve();
		streamMessages = [];
		const handleRequest = async (request: OrchestratorRequest): Promise<OrchestratorResponse> => {
			handledRequests.push(request);
			if (request.type === "rpc_stream") {
				await streamReadyDelay;
				return { type: "rpc_ready", ok: true, instance: { id: "test", cwd: "/tmp", status: "online" } };
			}
			return { type: "list_result", ok: true, instances: [] };
		};
		const handler = Object.assign(handleRequest, {
			openRpcStream: (_instanceId: string, onResponse: (response: unknown) => void) => ({
				async handleRequest(command: { id?: string; type: string }) {
					streamMessages.push(command);
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

	it("keeps stream commands that arrive while the stream is still opening", async () => {
		let releaseStream = () => {};
		streamReadyDelay = new Promise<void>((resolve) => {
			releaseStream = resolve;
		});
		client.write('{"type":"rpc_stream","instanceId":"test"}\n');
		await vi.waitFor(() => expect(handledRequests).toHaveLength(1));
		client.write('{"id":"early","type":"get_state"}\n');
		await new Promise((resolve) => setTimeout(resolve, 20));
		releaseStream();

		await vi.waitFor(() => {
			expect(responses).toEqual([
				{ type: "rpc_ready", ok: true, instance: { id: "test", cwd: "/tmp", status: "online" } },
				{ type: "response", id: "early", command: "get_state", success: true },
			]);
		});
		expect(handledRequests).toEqual([{ type: "rpc_stream", instanceId: "test" }]);
	});

	it("ends an ordinary request after one response despite trailing complete requests", async () => {
		const ended = once(client, "end");
		client.write('\n \n{"type":"list"}\n{"type":"list"}\n');
		await ended;
		expect(responses).toEqual([{ type: "list_result", ok: true, instances: [] }]);
		expect(handledRequests).toEqual([{ type: "list" }]);
	});

	it("decodes multibyte characters split across request chunks", async () => {
		const request = Buffer.from(
			'{"type":"rpc_stream","instanceId":"test"}\n{"id":"p","type":"prompt","message":"café"}\n',
		);
		const split = request.indexOf(0xa9);
		client.write(request.subarray(0, split));
		await vi.waitFor(() => expect(responses).toHaveLength(1));
		client.write(request.subarray(split));

		await vi.waitFor(() => expect(streamMessages).toEqual([{ id: "p", type: "prompt", message: "café" }]));
	});

	it("decodes multibyte characters split across the initial request", async () => {
		const request = Buffer.from('{"type":"spawn","cwd":"/tmp","label":"café"}\n');
		const split = request.indexOf(0xa9);
		client.write(request.subarray(0, split));
		await new Promise((resolve) => setTimeout(resolve, 20));
		client.write(request.subarray(split));

		await vi.waitFor(() => expect(handledRequests).toEqual([{ type: "spawn", cwd: "/tmp", label: "café" }]));
	});

	it("returns an error frame for malformed stream RPC commands without killing the stream", async () => {
		client.write('{"type":"rpc_stream","instanceId":"test"}\n{bad-json}\n{"id":"ok","type":"get_state"}\n');

		await vi.waitFor(() => {
			expect(responses).toHaveLength(3);
		});
		expect(responses[0]).toEqual({
			type: "rpc_ready",
			ok: true,
			instance: { id: "test", cwd: "/tmp", status: "online" },
		});
		expect(responses[1]).toMatchObject({ type: "error", ok: false });
		expect(responses[2]).toEqual({ type: "response", id: "ok", command: "get_state", success: true });
	});
});

describe("IPC client", () => {
	let directory: string;
	let server: Server;

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	it("decodes multibyte characters split across response chunks", async () => {
		directory = await mkdtemp(join(tmpdir(), "ipc-client-"));
		vi.stubEnv("PI_ORCHESTRATOR_DIR", directory);
		const response = Buffer.from(
			'{"type":"status_result","ok":true,"instance":{"id":"a","cwd":"/tmp","status":"online","label":"café"}}\n',
		);
		const split = response.indexOf(0xa9);
		server = createServer((socket) => {
			socket.once("data", () => {
				socket.write(response.subarray(0, split));
				setTimeout(() => socket.end(response.subarray(split)), 20);
			});
		});
		await new Promise<void>((resolve) => server.listen(getSocketPath(), resolve));

		expect(await sendIpcRequest({ type: "status", instanceId: "a" })).toMatchObject({ instance: { label: "café" } });
	});
});
