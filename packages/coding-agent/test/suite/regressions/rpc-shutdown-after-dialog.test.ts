import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it, vi } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

it("shuts down RPC mode after an extension command requests it behind a dialog", async () => {
	await withHeadlessPi(async (agent) => {
		const marker = join(agent.paths.tempDir, "session-shutdown.marker");
		const extensionsDir = join(agent.paths.agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(
			join(extensionsDir, "shutdown-after-dialog.ts"),
			`import { writeFileSync } from "node:fs";
			export default function (pi) {
				pi.on("session_shutdown", () => writeFileSync(${JSON.stringify(marker)}, "shutdown"));
				pi.registerCommand("shutdown-after-dialog", {
					description: "Confirm, then shut down",
					handler: async (_args, ctx) => {
						if (await ctx.ui.confirm("Shut down?", "Confirm shutdown")) ctx.shutdown();
					},
				});
			}`,
		);
		await agent.restart();

		const response = agent.send({ type: "prompt", message: "/shutdown-after-dialog" });
		const dialog = await agent.waitForExtensionUiRequest((request) => request.method === "confirm");
		await agent.respondToExtensionUiRequest({ type: "extension_ui_response", id: dialog.id, confirmed: true });
		expect((await response).success).toBe(true);

		await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10_000, interval: 50 });
	});
}, 60_000);

it("answers commands and the dialog of a command that requested RPC shutdown before asking", async () => {
	await withHeadlessPi(async (agent) => {
		const marker = join(agent.paths.tempDir, "session-shutdown.marker");
		const extensionsDir = join(agent.paths.agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(
			join(extensionsDir, "shutdown-before-dialog.ts"),
			`import { writeFileSync } from "node:fs";
			export default function (pi) {
				pi.on("session_shutdown", () => writeFileSync(${JSON.stringify(marker)}, "shutdown"));
				pi.registerCommand("shutdown-before-dialog", {
					description: "Shut down, then confirm",
					handler: async (_args, ctx) => {
						ctx.shutdown();
						await ctx.ui.confirm("Saved?", "Confirm before exit");
					},
				});
			}`,
		);
		await agent.restart();

		const response = agent.send({ type: "prompt", message: "/shutdown-before-dialog" });
		const dialog = await agent.waitForExtensionUiRequest((request) => request.method === "confirm");
		expect((await agent.send({ type: "get_state" })).success).toBe(true);
		expect(existsSync(marker)).toBe(false);
		await agent.respondToExtensionUiRequest({ type: "extension_ui_response", id: dialog.id, confirmed: true });
		expect((await response).success).toBe(true);

		await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10_000, interval: 50 });
	});
}, 60_000);

it("shuts down RPC mode when a turn started by an extension requests it", async () => {
	await withHeadlessPi(async (agent) => {
		const marker = join(agent.paths.tempDir, "session-shutdown.marker");
		const extensionsDir = join(agent.paths.agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(
			join(extensionsDir, "shutdown-after-turn.ts"),
			`import { writeFileSync } from "node:fs";
			export default function (pi) {
				pi.on("session_shutdown", () => writeFileSync(${JSON.stringify(marker)}, "shutdown"));
				pi.on("turn_end", (_event, ctx) => ctx.shutdown());
				pi.registerCommand("start-turn", {
					description: "Start a turn from the extension",
					handler: async () => pi.sendUserMessage("Extension-started turn"),
				});
			}`,
		);
		await agent.restart();

		expect((await agent.send({ type: "prompt", message: "/start-turn" })).success).toBe(true);
		const request = await agent.waitForLlmRequest((candidate) =>
			candidate.userMessages.includes("Extension-started turn"),
		);
		agent.respondToLlmRequest(
			request.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Done" }), { stopReason: "toolUse" }),
		);

		await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10_000, interval: 50 });
	});
}, 60_000);
