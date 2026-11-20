import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { assertDefined } from "./utilities.ts";

const model = assertDefined(getModel("anthropic", "claude-sonnet-4-5"));
const usage = (totalTokens: number) => ({
	input: totalTokens,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

describe("selected child footer context usage", () => {
	it("estimates the compacted context instead of reusing usage reported before the compaction", () => {
		const child = SessionManager.inMemory();
		child.appendModelChange(model.provider, model.id);
		child.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const keptId = child.appendMessage({ role: "user", content: "keep", timestamp: 2 });
		child.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(195_000),
			stopReason: "stop",
			timestamp: 3,
		});
		child.appendCompaction("summary", keptId, 195_000);
		const host = {
			childViewSessionManager: child,
			session: { modelRegistry: { find: () => model } },
		};

		const override = (
			InteractiveMode.prototype as unknown as {
				buildSelectedAgentFooterOverride(this: typeof host): { contextUsage?: { tokens: number } } | undefined;
			}
		).buildSelectedAgentFooterOverride.call(host);

		expect(override?.contextUsage?.tokens).toBeGreaterThan(0);
		expect(override?.contextUsage?.tokens).toBeLessThan(1_000);
	});
});
