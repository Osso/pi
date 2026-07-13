import { describe, expect, it } from "vitest";
import {
	buildDetachedToolCallCompletionEntry,
	DETACHED_TOOL_CALL_COMPLETION_CUSTOM_TYPE,
} from "../src/core/agent-session.ts";
import type { AgentSnapshot } from "../src/core/multi-agent-store.ts";

function detachedJob(overrides: Partial<AgentSnapshot>): AgentSnapshot {
	return {
		id: "agent_2",
		parentId: undefined,
		displayName: "Pyrun evaluation",
		agentType: "background",
		lifecycle: "completed",
		revision: 1,
		createdAt: "2026-07-13T00:00:00.000Z",
		updatedAt: "2026-07-13T00:00:01.000Z",
		cwd: "/tmp",
		permission: { policy: "on-request", narrowed: true },
		worker: { adapter: "runtime", handleId: "4242", cwd: "/tmp", toolCallId: "toolcall-abc" },
		...overrides,
	};
}

describe("buildDetachedToolCallCompletionEntry", () => {
	it("uses a stable custom-entry type", () => {
		expect(DETACHED_TOOL_CALL_COMPLETION_CUSTOM_TYPE).toBe("detached_tool_call_completion");
	});

	it("carries toolCallId and summary for a completed detached job", () => {
		const entry = buildDetachedToolCallCompletionEntry(
			detachedJob({ lifecycle: "completed", result: { summary: "Pyrun evaluation completed." } }),
		);
		expect(entry).toEqual({
			agentId: "agent_2",
			lifecycle: "completed",
			toolCallId: "toolcall-abc",
			summary: "Pyrun evaluation completed.",
		});
	});

	it("uses the persisted terminal result after the runtime worker is cleared", () => {
		const entry = buildDetachedToolCallCompletionEntry(
			detachedJob({
				lifecycle: "completed",
				result: { summary: "Pyrun evaluation completed.", toolCallId: "terminal-tool-call" },
				worker: undefined,
			}),
		);
		expect(entry).toMatchObject({ lifecycle: "completed", toolCallId: "terminal-tool-call" });
	});

	it("carries the error message for a failed detached job", () => {
		const entry = buildDetachedToolCallCompletionEntry(
			detachedJob({ lifecycle: "failed", error: { message: "boom" } }),
		);
		expect(entry).toMatchObject({ lifecycle: "failed", toolCallId: "toolcall-abc", error: "boom" });
		expect(entry?.summary).toBeUndefined();
	});

	it("records aborted detached jobs", () => {
		expect(buildDetachedToolCallCompletionEntry(detachedJob({ lifecycle: "aborted" }))?.lifecycle).toBe("aborted");
	});

	it("returns undefined while the job is still active", () => {
		expect(buildDetachedToolCallCompletionEntry(detachedJob({ lifecycle: "running" }))).toBeUndefined();
	});

	it("returns undefined for agents with no originating tool call", () => {
		expect(
			buildDetachedToolCallCompletionEntry(detachedJob({ worker: { adapter: "runtime", handleId: "4242" } })),
		).toBeUndefined();
		expect(buildDetachedToolCallCompletionEntry(detachedJob({ worker: undefined }))).toBeUndefined();
		expect(buildDetachedToolCallCompletionEntry(undefined)).toBeUndefined();
	});
});
