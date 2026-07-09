import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	blockArchitectGlobalBroadcast,
	createArchitectSettingsManager,
	createArchitectStopHandler,
	runArchitectCycle,
	waitForArchitectInterval,
} from "../src/architect/main.ts";
import { ARCHITECT_SYSTEM_PROMPT, buildArchitectPrompt } from "../src/architect/prompt.ts";

const deployScript = fileURLToPath(new URL("../../../deploy.sh", import.meta.url));
const serviceUnit = fileURLToPath(new URL("../systemd/pi-architect.service", import.meta.url));

describe("resident architect service", () => {
	it("uses the structured observer snapshot instead of list_sessions", () => {
		const prompt = buildArchitectPrompt({ reason: "session_state_changed", requests: [], sessions: [] });

		expect(prompt).not.toContain("list_sessions");
		expect(ARCHITECT_SYSTEM_PROMPT).toContain("Do not call list_sessions");
	});

	it("uses the read-only Bubblewrap profile", () => {
		expect(createArchitectSettingsManager().getExplicitSandboxProfile()).toBe("read-only");
	});

	it("blocks global fanout while permitting one targeted session delivery", () => {
		expect(blockArchitectGlobalBroadcast({ input: {}, toolName: "channel_post" })).toMatchObject({ block: true });
		expect(blockArchitectGlobalBroadcast({ input: {}, toolName: "broadcast" })).toMatchObject({ block: true });
		expect(blockArchitectGlobalBroadcast({ input: {}, toolName: "list_sessions" })).toMatchObject({ block: true });
		expect(
			blockArchitectGlobalBroadcast({ input: { session_ids: ["affected-session"] }, toolName: "broadcast" }),
		).toBeUndefined();
	});

	it("forces service shutdown after a bounded graceful abort", async () => {
		vi.useFakeTimers();
		try {
			const controller = new AbortController();
			const abortSession = vi.fn(() => new Promise<void>(() => {}));
			const exit = vi.fn();
			const stop = createArchitectStopHandler({ abortController: controller, abortSession, exit });

			stop();
			await vi.advanceTimersByTimeAsync(5_000);

			expect(controller.signal.aborted).toBe(true);
			expect(abortSession).toHaveBeenCalledOnce();
			expect(exit).toHaveBeenCalledWith(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops the observation wait immediately when the service is signaled", async () => {
		const controller = new AbortController();
		const wait = waitForArchitectInterval(controller.signal);
		controller.abort();

		await expect(wait).resolves.toBeUndefined();
	});

	it("does not prompt Sol when the observer has no material change", async () => {
		let promptCount = 0;

		await runArchitectCycle({ observe: () => undefined }, async () => {
			promptCount += 1;
		});

		expect(promptCount).toBe(0);
	});

	it("prompts Sol with the material observation", async () => {
		const observation = {
			reason: "session_state_changed" as const,
			requests: [],
			sessions: [],
		};
		let received: unknown;

		await runArchitectCycle({ observe: () => observation }, async (prompt) => {
			received = prompt;
		});

		expect(received).toContain("session_state_changed");
	});

	it("deploys and restarts the compiled pi architect service", () => {
		const deploy = readFileSync(deployScript, "utf8");
		const unit = readFileSync(serviceUnit, "utf8");

		expect(unit).toContain("ExecStart=%h/.local/bin/pi architect");
		expect(deploy).toContain("pi-architect.service");
		expect(deploy).toContain("systemctl --user daemon-reload");
		expect(deploy).toContain("systemctl --user enable --now pi-architect.service");
		expect(deploy).toContain("systemctl --user restart pi-architect.service");
	});
});
