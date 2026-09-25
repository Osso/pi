import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

describe("RpcClient clone", () => {
	it("sends the clone RPC command", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({
			type: "response",
			command: "clone",
			success: true,
			data: { cancelled: false },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => {
			return (response as { data: T }).data;
		};

		const result = await client.clone();

		expect(send).toHaveBeenCalledWith({ type: "clone" });
		expect(result).toEqual({ cancelled: false });
	});

	it("ignores null, array, and untyped JSON stdout lines without throwing or emitting events", () => {
		const client = new RpcClient();
		const events: unknown[] = [];
		client.onEvent((event) => events.push(event));

		const internal = client as unknown as { handleLine: (line: string) => void };
		expect(() => {
			internal.handleLine("null");
			internal.handleLine("[]");
			internal.handleLine("{}");
		}).not.toThrow();
		expect(events).toEqual([]);
	});

	it("delivers an event to every listener when an earlier listener unsubscribes during dispatch", () => {
		const client = new RpcClient();
		const received: string[] = [];
		const unsubscribe = client.onEvent(() => unsubscribe());
		client.onEvent((event) => received.push(event.type));

		(client as unknown as { handleLine: (line: string) => void }).handleLine('{"type":"agent_end","messages":[]}');
		expect(received).toEqual(["agent_end"]);
	});
});
