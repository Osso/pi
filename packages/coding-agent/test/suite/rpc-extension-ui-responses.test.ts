import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RpcClient } from "../../src/modes/rpc/rpc-client.ts";
import { withHeadlessPi } from "./headless-pi.ts";

const cliPath = join(import.meta.dirname, "fixtures", "rpc-extension-ui-cli.ts");

describe("RPC extension UI responses", () => {
	it("rejects a response when the client has not started", async () => {
		const client = new RpcClient();
		await expect(
			client.respondToExtensionUiRequest({ type: "extension_ui_response", id: "dialog", confirmed: true }),
		).rejects.toThrow("Client not started");
	});

	it("delivers confirmation and input responses before and after restart", async () => {
		await withHeadlessPi(
			async (agent) => {
				for (const [confirmed, value] of [
					[true, "hello"],
					[false, null],
				] as const) {
					const command = agent.send({ type: "prompt", message: "/test-ui" });
					const confirm = await agent.waitForExtensionUiRequest((request) => request.method === "confirm");
					await agent.respondToExtensionUiRequest({ type: "extension_ui_response", id: confirm.id, confirmed });
					const input = await agent.waitForExtensionUiRequest((request) => request.method === "input");
					await agent.respondToExtensionUiRequest(
						value === null
							? { type: "extension_ui_response", id: input.id, cancelled: true }
							: { type: "extension_ui_response", id: input.id, value },
					);
					const result = await agent.waitForExtensionUiRequest(
						(request) => request.method === "notify" && request.message === JSON.stringify({ confirmed, value }),
					);
					expect(result.method).toBe("notify");
					expect((await command).success).toBe(true);
					if (confirmed) await agent.restart();
				}
			},
			{ cliPath },
		);
	}, 60_000);
});
