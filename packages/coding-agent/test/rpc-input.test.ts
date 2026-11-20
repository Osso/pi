import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readRpcInputFromStartup } from "../src/modes/rpc/rpc-input.ts";
import type { RpcExtensionUIResponse } from "../src/modes/rpc/rpc-types.ts";

describe("readRpcInputFromStartup", () => {
	it("cancels an open startup dialog when stdin closes, then reports EOF on start", async () => {
		const stdin = new PassThrough();
		const answers: RpcExtensionUIResponse[] = [];
		const pending = new Map([
			["dialog-1", { resolve: (response: RpcExtensionUIResponse) => answers.push(response) }],
		]);
		const input = readRpcInputFromStartup(stdin, pending);

		stdin.end();
		await vi.waitFor(() =>
			expect(answers).toEqual([{ type: "extension_ui_response", id: "dialog-1", cancelled: true }]),
		);

		const onEnd = vi.fn();
		input.start(() => {}, onEnd);
		expect(onEnd).toHaveBeenCalledOnce();
	});
});
