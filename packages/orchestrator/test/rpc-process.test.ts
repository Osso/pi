import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const spawnState = vi.hoisted(() => ({
	child: undefined as
		| (EventEmitter & {
				stdin: PassThrough;
				stdout: PassThrough;
				stderr: PassThrough;
				kill: ReturnType<typeof vi.fn>;
		  })
		| undefined,
}));

vi.mock("node:module", () => ({
	createRequire: () => ({
		resolve: () => "/tmp/mock-rpc-entry.js",
	}),
}));

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => {
		const child = new EventEmitter() as EventEmitter & {
			stdin: PassThrough;
			stdout: PassThrough;
			stderr: PassThrough;
			kill: ReturnType<typeof vi.fn>;
		};
		child.stdin = new PassThrough();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = vi.fn(() => {
			queueMicrotask(() => child.emit("exit", 0, null));
			return true;
		});
		spawnState.child = child;
		return child;
	}),
}));

import { createRpcProcessInstance } from "../src/rpc-process.ts";

describe("RpcProcessInstance stdout framing", () => {
	it("ignores non-JSON and primitive stdout lines without crashing and resolves subsequent responses", async () => {
		const instance = createRpcProcessInstance({ cwd: "/tmp" });
		const child = spawnState.child;
		if (!child) throw new Error("Expected mocked child process");

		const events: unknown[] = [];
		instance.onEvent((event) => events.push(event));

		const responsePromise = instance.send({ id: "req-1", type: "get_state" });
		child.stdout.write("not valid json\nnull\n[1,2]\n");
		child.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
		child.stdout.write(`${JSON.stringify({ id: "req-1", type: "response", command: "get_state", success: true })}\n`);

		const response = await responsePromise;
		expect(response).toEqual({ id: "req-1", type: "response", command: "get_state", success: true });
		expect(events).toEqual([{ type: "agent_start" }]);

		await instance.dispose();
	});
});
