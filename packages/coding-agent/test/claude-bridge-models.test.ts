import { describe, expect, it } from "vitest";
import { resolveClaudeCodeRuntimeModel } from "../extensions/claude-bridge/src/models.ts";

describe("Claude bridge runtime model", () => {
	it("requests Fable 5.2 with its 1M context window", () => {
		expect(
			resolveClaudeCodeRuntimeModel({ id: "claude-fable-5-2" }, { plan: "pro", longContextExtraUsage: false }),
		).toEqual({ cliModelId: "claude-fable-5-2[1m]", contextWindow: 1_000_000 });
	});
});
