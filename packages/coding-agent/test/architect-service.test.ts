import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	ARCHITECT_EXCLUDED_TOOL_NAMES,
	blockArchitectGlobalBroadcast,
	completeSentArchitectRequest,
	createArchitectMultiAgentStore,
	createArchitectSettingsManager,
	createArchitectStopHandler,
	runArchitectCycle,
	waitForArchitectInterval,
} from "../src/architect/main.ts";
import { ARCHITECT_SYSTEM_PROMPT, buildArchitectPrompt } from "../src/architect/prompt.ts";
import { getControlDbPath, readSessionMetadata } from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SUPERVISOR_ONLY_TOOL_NAMES } from "../src/core/tool-capabilities.ts";

const deployScript = fileURLToPath(new URL("../../../deploy.sh", import.meta.url));
const serviceUnit = fileURLToPath(new URL("../systemd/pi-architect.service", import.meta.url));

describe("resident architect service", () => {
	it("uses the structured observer snapshot instead of list_sessions", () => {
		const prompt = buildArchitectPrompt({ reason: "session_state_changed", requests: [], sessions: [] });

		expect(prompt).not.toContain("list_sessions");
		expect(ARCHITECT_SYSTEM_PROMPT).toContain("Do not call list_sessions");
	});

	it("anchors liveness to prefiltered snapshot membership instead of goal fields", () => {
		expect(ARCHITECT_SYSTEM_PROMPT).toContain(
			"Goal completion does not end a live session or require it to disappear from observations.",
		);
		expect(ARCHITECT_SYSTEM_PROMPT).toContain("Treat completedAt only as goal state.");
		expect(ARCHITECT_SYSTEM_PROMPT).toContain(
			"The bounded sessions list already represents main-listener and fresh-health filtering.",
		);
		expect(ARCHITECT_SYSTEM_PROMPT).toContain("Use session membership, never goal fields, as liveness evidence.");
	});

	it("uses the read-only Bubblewrap profile", () => {
		expect(createArchitectSettingsManager().getExplicitSandboxProfile()).toBe("read-only");
	});

	it("keeps supervisor-only tools out of the architect runtime", () => {
		expect(ARCHITECT_EXCLUDED_TOOL_NAMES).toEqual([
			"ask_architect",
			"broadcast",
			"contact_supervisor",
			...SUPERVISOR_ONLY_TOOL_NAMES,
		]);
	});

	it("persists direct-message state to the shared control DB", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-architect-store-"));
		try {
			const sessionManager = SessionManager.create("/home/osso", agentDir, { id: "architect" });
			const store = createArchitectMultiAgentStore(sessionManager, agentDir);
			const sessionPath = sessionManager.getSessionFile();
			if (!sessionPath) throw new Error("Architect session should be persisted");

			expect(store.getPersistenceTarget()).toEqual({
				controlDbPath: join(agentDir, "control.sqlite"),
				sessionPath,
			});
			expect(readSessionMetadata(getControlDbPath(agentDir), sessionPath)).toMatchObject({
				isArchived: true,
				archivedAt: expect.any(String),
			});
		} finally {
			rmSync(agentDir, { force: true, recursive: true });
		}
	});

	it("blocks global fanout and broadcast delivery", () => {
		expect(blockArchitectGlobalBroadcast({ input: {}, toolName: "channel_post" })).toMatchObject({ block: true });
		expect(blockArchitectGlobalBroadcast({ input: {}, toolName: "broadcast" })).toMatchObject({ block: true });
		expect(
			blockArchitectGlobalBroadcast({ input: { session_ids: ["affected-session"] }, toolName: "broadcast" }),
		).toMatchObject({ block: true });
		expect(blockArchitectGlobalBroadcast({ input: {}, toolName: "list_sessions" })).toMatchObject({ block: true });
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

	it("completes a durable Architect request only after successful direct transport", () => {
		const completeRequest = vi.fn();

		completeSentArchitectRequest(
			{ completeRequest },
			{ threadId: "architect-request:7", toAgentId: "main", toSessionId: "main-session" },
		);
		completeSentArchitectRequest(
			{ completeRequest },
			{ threadId: "unrelated", toAgentId: "main", toSessionId: "main-session" },
		);
		completeSentArchitectRequest(
			{ completeRequest },
			{ threadId: "architect-request:8", toAgentId: "agent_1", toSessionId: "main-session" },
		);

		expect(completeRequest).toHaveBeenCalledOnce();
		expect(completeRequest).toHaveBeenCalledWith(7, "main-session");
	});

	it("renews request claims while a model turn remains active", async () => {
		vi.useFakeTimers();
		try {
			const observation = {
				reason: "architect_request" as const,
				requests: [
					{
						id: 7,
						senderSessionId: "main-session",
						body: "inspect this",
						status: "claimed" as const,
						createdAt: "2026-07-10T00:00:00.000Z",
					},
				],
				sessions: [],
			};
			const renewRequests = vi.fn();
			let releasePrompt: (() => void) | undefined;
			const prompt = new Promise<void>((resolve) => {
				releasePrompt = resolve;
			});
			const cycle = runArchitectCycle({ observe: () => observation, renewRequests }, () => prompt);

			await vi.advanceTimersByTimeAsync(30_000);
			expect(renewRequests).toHaveBeenCalledWith([7]);
			releasePrompt?.();
			await cycle;
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders the configured binary path and verifies the restarted Architect service", () => {
		const deploy = readFileSync(deployScript, "utf8");
		const unit = readFileSync(serviceUnit, "utf8");

		expect(unit).toContain("ExecStart=@PI_ARCHITECT_BINARY@ architect");
		expect(deploy).toContain("@PI_ARCHITECT_BINARY@");
		expect(deploy).toContain("pi-architect.service");
		expect(deploy).toContain("systemctl --user daemon-reload");
		expect(deploy).toContain("systemctl --user enable --now pi-architect.service");
		expect(deploy).toContain("systemctl --user restart pi-architect.service");
		expect(deploy).toContain("systemctl --user is-active --quiet pi-architect.service");
		expect(deploy).not.toContain('"$USER"');
	});
});
