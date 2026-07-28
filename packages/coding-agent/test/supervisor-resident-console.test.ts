import { describe, expect, it, vi } from "vitest";
import type { SupervisorRequest } from "../src/core/session-control-db.ts";
import {
	createSupervisorConsoleSnapshot,
	runSupervisorRequestLoop,
	SupervisorConsolePromptQueue,
} from "../src/supervisor/main.ts";

function pendingRequest(): SupervisorRequest {
	return {
		claimToken: "claim-token",
		claimedAt: "2026-07-28T00:00:00.000Z",
		createdAt: "2026-07-28T00:00:00.000Z",
		deadlineAt: "2026-07-28T00:01:00.000Z",
		id: 1,
		kind: "approval_review",
		payload: {},
		projectId: "pi",
		senderSessionId: "sender",
		status: "claimed",
	};
}

describe("Supervisor resident console", () => {
	it("exposes the exact resident branch identity", () => {
		const branch = [{ type: "custom" as const, id: "entry", parentId: null, timestamp: "now", customType: "test" }];
		expect(
			createSupervisorConsoleSnapshot({
				cwd: "/fixed/supervisor",
				generation: 42,
				session: { sessionId: "supervisor", sessionManager: { getBranch: () => branch, getLeafId: () => null } },
			}),
		).toEqual({
			service: "supervisor",
			sessionId: "supervisor",
			cwd: "/fixed/supervisor",
			generation: 42,
			branch,
		});
	});

	it("processes typed requests before queued console prompts without interleaving", async () => {
		const request = pendingRequest();
		const queue = new SupervisorConsolePromptQueue();
		queue.enqueue("console message", "console-1");
		const order: string[] = [];
		const controller = new AbortController();
		const claimNextRequest = vi.fn().mockReturnValueOnce(request).mockReturnValue(undefined);
		const processRequest = vi.fn(async () => {
			order.push("request:start");
			await Promise.resolve();
			order.push("request:end");
		});
		const prompt = vi.fn(async (text: string) => {
			order.push(`console:${text}`);
			controller.abort();
		});

		await runSupervisorRequestLoop({
			claimNextRequest,
			claimToken: "claim-token",
			consolePrompts: queue,
			controlDbPath: "/tmp/control.sqlite",
			processRequest,
			session: {
				abort: async () => {},
				prompt,
				sessionManager: { getBranch: () => [], getLeafId: () => null },
			},
			signal: controller.signal,
			wakeServer: {
				currentGeneration: () => 0,
				waitForWakeAfter: async () => {},
			},
		});

		expect(order).toEqual(["request:start", "request:end", "console:console message"]);
	});
});
