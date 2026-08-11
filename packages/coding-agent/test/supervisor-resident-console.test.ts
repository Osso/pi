import { describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import type { SupervisorRequest } from "../src/core/session-control-db.ts";
import {
	createSupervisorConsoleSnapshot,
	runSupervisorRequestLoop,
	SupervisorConsolePromptQueue,
} from "../src/supervisor/main.ts";
import { createSupervisorResponseTool } from "../src/supervisor/response-tool.ts";

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
	it("returns advisory answers as the visible Supervisor tool result", async () => {
		const tool = createSupervisorResponseTool();
		const result = await tool.execute(
			"response-1",
			{ kind: "advisory", answer: "Hello." },
			undefined,
			undefined,
			{} as Parameters<typeof tool.execute>[4],
		);

		expect(result.content).toEqual([{ type: "text", text: "Hello." }]);
	});

	it("exposes the exact resident branch and process identity", () => {
		const branch = [{ type: "custom" as const, id: "entry", parentId: null, timestamp: "now", customType: "test" }];
		const snapshot = createSupervisorConsoleSnapshot({
			cwd: "/fixed/supervisor",
			generation: 42,
			managedBy: "external",
			session: { sessionId: "supervisor", sessionManager: { getBranch: () => branch, getLeafId: () => null } },
		});
		const secondSnapshot = createSupervisorConsoleSnapshot({
			cwd: "/fixed/supervisor",
			generation: 43,
			managedBy: "external",
			session: { sessionId: "supervisor", sessionManager: { getBranch: () => branch, getLeafId: () => null } },
		});

		expect(snapshot).toMatchObject({
			service: "supervisor",
			sessionId: "supervisor",
			cwd: "/fixed/supervisor",
			generation: 42,
			identity: {
				version: VERSION,
				pid: process.pid,
				executable: process.execPath,
				instanceId: expect.any(String),
				managedBy: "external",
				ready: true,
			},
			branch,
		});
		if (process.argv[1]) expect(snapshot.identity?.entrypoint).toBe(process.argv[1]);
		expect(secondSnapshot.identity?.instanceId).toBe(snapshot.identity?.instanceId);
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
