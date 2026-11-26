import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";

describe("RPC share_session", () => {
	it("exports the current session through gh and returns the viewer URL", async () => {
		const fakeBin = mkdtempSync(join(tmpdir(), "pi-rpc-share-bin-"));
		const fakeGh = join(fakeBin, "gh");
		writeFileSync(
			fakeGh,
			'#!/bin/sh\nif [ "$1" = "gist" ]; then echo https://gist.github.com/test-user/abc123; fi\n',
		);
		chmodSync(fakeGh, 0o755);
		try {
			await withHeadlessPi(
				async (agent) => {
					await agent.send({ type: "prompt", message: "Create shareable content" });
					const request = await agent.waitForLlmRequest();
					agent.respondToLlmRequest(
						request.id,
						fauxAssistantMessage(
							[{ type: "text", text: "Share fixture." }, fauxToolCall("end_turn", { reason: "Done" })],
							{
								stopReason: "toolUse",
							},
						),
					);
					await agent.waitForEvent((event) => event.type === "agent_settled");
					const result = await agent.send({ type: "share_session" });
					expect(result, JSON.stringify(result)).toMatchObject({ command: "share_session", success: true });
					expect((result as { data: { url: string } }).data.url).toContain("abc123");
				},
				{ env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}` } },
			);
		} finally {
			rmSync(fakeBin, { recursive: true, force: true });
		}
	}, 60_000);
});
