import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

// A session_start dialog blocks RPC startup; its reply must be read before startup completes.
it("delivers the client's reply to a dialog opened during RPC startup", async () => {
	await withHeadlessPi(async (agent) => {
		const marker = join(agent.paths.tempDir, "startup-dialog.result");
		const extensionsDir = join(agent.paths.agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(
			join(extensionsDir, "startup-dialog.ts"),
			`import { writeFileSync } from "node:fs";
			export default function (pi) {
				pi.on("session_start", async (_event, ctx) => {
					const confirmed = await ctx.ui.confirm("Startup confirmation", "Proceed?", { timeout: 20_000 });
					writeFileSync(${JSON.stringify(marker)}, String(confirmed));
				});
			}`,
		);

		const restarting = agent.restart();
		const dialog = await agent.waitForExtensionUiRequest(
			(request) => request.method === "confirm" && request.title === "Startup confirmation",
		);
		await agent.respondToExtensionUiRequest({ type: "extension_ui_response", id: dialog.id, confirmed: true });
		await restarting;

		await vi.waitFor(() => expect(readFileSync(marker, "utf-8")).toBe("true"), { timeout: 5_000, interval: 50 });
	});
}, 60_000);
