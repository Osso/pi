import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, ENV_STATE_DIR } from "../../../src/config.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { RESIDENT_CONSOLE_PROTOCOL_VERSION } from "../../../src/core/resident-console-transport.ts";
import { getControlDbPath } from "../../../src/core/session-control-db.ts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const cliPath = join(import.meta.dirname, "..", "..", "..", "src", "cli.ts");

const codexToken = `aaa.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
).toString("base64")}.bbb`;

const codexReply = [
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "OK" },
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "OK" }],
		},
	},
	{
		type: "response.completed",
		response: {
			id: "resp_1",
			status: "completed",
			usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6, input_tokens_details: { cached_tokens: 0 } },
		},
	},
];

function encodeTextFrame(text: string): Buffer {
	const payload = Buffer.from(text);
	if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
	const header = Buffer.alloc(4);
	header[0] = 0x81;
	header[1] = 126;
	header.writeUInt16BE(payload.length, 2);
	return Buffer.concat([header, payload]);
}

/** Minimal Codex WebSocket endpoint: answers every client frame with one complete response and keeps the socket open. */
function startFakeCodexServer(): Promise<{
	server: Server;
	baseUrl: string;
	sockets: Set<Socket>;
	requests: () => number;
	closeFrames: () => number;
}> {
	const sockets = new Set<Socket>();
	let requests = 0;
	let closeFrames = 0;
	const server = createServer((_request, response) => {
		response.writeHead(500).end("SSE fallback is not expected");
	});
	server.on("upgrade", (request, socket) => {
		const key = request.headers["sec-websocket-key"];
		const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		sockets.add(socket as Socket);
		socket.on("error", () => socket.destroy());
		socket.on("close", () => sockets.delete(socket as Socket));
		socket.on("data", (frame: Buffer) => {
			const opcode = frame[0] & 0x0f;
			if (opcode === 0x8) {
				closeFrames += 1;
				socket.end(Buffer.from([0x88, 0]));
				return;
			}
			if (opcode === 0x9) {
				socket.write(Buffer.concat([Buffer.from([0x8a, 0]), Buffer.alloc(0)]));
				return;
			}
			if (opcode !== 0x1) return;
			requests += 1;
			for (const event of codexReply) socket.write(encodeTextFrame(JSON.stringify(event)));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Fake Codex server has no port");
			resolve({
				server,
				baseUrl: `http://127.0.0.1:${address.port}`,
				sockets,
				requests: () => requests,
				closeFrames: () => closeFrames,
			});
		});
	});
}

function createFixture(baseUrl: string) {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-supervisor-sigterm-"));
	const agentDir = join(tempDir, "agent");
	const stateDir = join(tempDir, "state");
	const kbDir = join(tempDir, "kb");
	const homeDir = join(tempDir, "home");
	for (const dir of [agentDir, stateDir, kbDir, homeDir]) mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"openai-codex": {
					api: "openai-codex-responses",
					baseUrl,
					models: [{ id: "gpt-6.1-sol", reasoning: true }],
				},
			},
		}),
	);
	AuthStorage.create(join(agentDir, "auth.json")).set("openai-codex", { type: "api_key", key: codexToken });
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: homeDir,
		XDG_CONFIG_HOME: join(homeDir, "config"),
		XDG_CACHE_HOME: join(homeDir, "cache"),
		XDG_STATE_HOME: stateDir,
		[ENV_AGENT_DIR]: agentDir,
		[ENV_STATE_DIR]: stateDir,
		PI_KB_DIR: kbDir,
		PI_SKIP_VERSION_CHECK: "1",
		PI_OFFLINE: "1",
		PI_SUPERVISOR_AUTOSTARTED: "1",
	};
	return { tempDir, kbDir, env, socketPath: `${getControlDbPath(stateDir)}.supervisor-console.sock` };
}

async function waitForPath(path: string, child: ChildProcess, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path)) {
		if (child.exitCode !== null) throw new Error(`Supervisor exited ${child.exitCode} before its console started`);
		if (Date.now() > deadline) throw new Error(`Supervisor console did not start within ${timeoutMs}ms`);
		await delay(50);
	}
}

/** Attaches to the Supervisor console, submits one prompt, and resolves when that turn ends. */
function promptSupervisor(socketPath: string, text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		let buffer = "";
		socket.on("error", reject);
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
				const message = JSON.parse(buffer.slice(0, newline)) as { type: string; event?: { type?: string } };
				buffer = buffer.slice(newline + 1);
				if (message.type === "error") reject(new Error(JSON.stringify(message)));
				if (message.event?.type === "agent_end") {
					socket.end();
					resolve();
				}
			}
		});
		socket.write(
			`${JSON.stringify({ type: "attach", version: RESIDENT_CONSOLE_PROTOCOL_VERSION, service: "supervisor" })}\n`,
		);
		socket.write(`${JSON.stringify({ type: "prompt", id: "sigterm-1", text })}\n`);
	});
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null | "timeout"> {
	if (child.exitCode !== null) return Promise.resolve(child.exitCode);
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve("timeout"), timeoutMs);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Supervisor SIGTERM after a provider request", () => {
	it("exits promptly while its cached Codex WebSocket is still open", async () => {
		const codex = await startFakeCodexServer();
		cleanups.push(
			() =>
				new Promise<void>((resolve) => {
					for (const socket of codex.sockets) socket.destroy();
					codex.server.close(() => resolve());
				}),
		);
		const fixture = createFixture(codex.baseUrl);
		const child = spawn(process.execPath, ["--experimental-strip-types", cliPath, "supervisor"], {
			cwd: fixture.kbDir,
			env: fixture.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout?.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			output += chunk;
		});
		cleanups.push(async () => {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
				await waitForExit(child, 2_000);
			}
			rmSync(fixture.tempDir, { force: true, recursive: true });
		});

		await waitForPath(fixture.socketPath, child, 30_000);
		await promptSupervisor(fixture.socketPath, "Reply with the single word OK.");
		expect(codex.requests()).toBeGreaterThan(0);
		expect(codex.sockets.size).toBeGreaterThan(0);

		child.kill("SIGTERM");
		const exit = await waitForExit(child, 5_000);

		expect(exit, output).toBe(0);
		expect(codex.closeFrames()).toBeGreaterThan(0);
		expect(existsSync(fixture.socketPath)).toBe(false);
	}, 60_000);
});
