// Lives outside .pi/extensions because pi loads every .ts file there as an extension.
// .pi is also outside every package's vitest root, so run this explicitly:
//   npx --prefix packages/coding-agent vitest run --dir "$PWD/.pi"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import registerTps, { formatStats, type LoopStats, type Span, unionMs } from "../extensions/tps.ts";

function loopStats(overrides: Partial<LoopStats>): LoopStats {
	return { elapsedMs: 0, requests: [], toolSpans: [], input: 0, output: 0, totalTokens: 0, ...overrides };
}

interface TestEvent {
	type: string;
	[key: string]: unknown;
}

interface TestContext {
	hasUI: boolean;
	ui: { notify: (message: string) => void };
}

type TestHandler = (event: TestEvent, ctx: TestContext) => void;

function createEventHarness(): {
	fire: (event: string, payload?: Record<string, unknown>) => void;
	notices: string[];
} {
	const handlers = new Map<string, TestHandler>();
	const notices: string[] = [];
	const ctx: TestContext = { hasUI: true, ui: { notify: (message) => notices.push(message) } };
	const api = {
		on: (event: string, handler: unknown) => handlers.set(event, handler as TestHandler),
	} as unknown as ExtensionAPI;
	registerTps(api);
	return {
		fire: (event, payload = {}) => handlers.get(event)?.({ type: event, ...payload }, ctx),
		notices,
	};
}

function assistant(output: number) {
	return { role: "assistant", usage: { input: 1_000, output, totalTokens: 1_000 + output } };
}

describe("unionMs", () => {
	it("counts overlapping spans once", () => {
		const spans: Span[] = [
			{ startMs: 0, endMs: 30_000 },
			{ startMs: 5_000, endMs: 15_000 },
		];
		expect(unionMs(spans)).toBe(30_000);
	});

	it("adds disjoint spans and ignores empty ones", () => {
		const spans: Span[] = [
			{ startMs: 0, endMs: 1_000 },
			{ startMs: 2_000, endMs: 2_000 },
			{ startMs: 5_000, endMs: 6_500 },
		];
		expect(unionMs(spans)).toBe(2_500);
	});
});

describe("formatStats", () => {
	it("reports TPS over full request time", () => {
		const stats = loopStats({
			elapsedMs: 45_000,
			// Two requests: 2s to first token, then 4s of streaming, 400 tokens each.
			requests: [
				{ startMs: 0, firstTokenAtMs: 2_000, endMs: 6_000, outputTokens: 400 },
				{ startMs: 37_000, firstTokenAtMs: 39_000, endMs: 43_000, outputTokens: 400 },
			],
			toolSpans: [{ startMs: 6_000, endMs: 36_000 }],
			input: 2_000,
			output: 800,
			totalTokens: 2_800,
		});

		// TPS 800 tok / 12s of requests.
		expect(formatStats(stats)).toBe(
			"TPS 66.7 tok/s (800 tok in 12.0s of requests) · TTFT p50 2.0s max 2.0s · " +
				// other = 45.0s loop - 12.0s requests - 30.0s tools, i.e. the 1.0s and 2.0s gaps.
				"tools 30.0s · other 3.0s · 2 req · out 800, in 2,000, total 2,800 · loop 45.0s",
		);
	});

	it("omits unavailable optional metrics, tools and overhead when there is nothing to report", () => {
		const stats = loopStats({
			elapsedMs: 6_000,
			requests: [{ startMs: 0, endMs: 6_000, outputTokens: 120 }],
			input: 500,
			output: 120,
			totalTokens: 620,
		});

		const line = formatStats(stats);
		expect(line).toBe("TPS 20.0 tok/s (120 tok in 6.0s of requests) · 1 req · out 120, in 500, total 620 · loop 6.0s");
	});
});

describe("event wiring", () => {
	it("measures a loop from model and tool events", () => {
		const { fire, notices } = createEventHarness();
		let now = 1_000;
		const realNow = Date.now;
		Date.now = () => now;

		try {
			fire("agent_start");
			fire("model_request_start");
			now += 2_000;
			fire("message_update", { assistantMessageEvent: { type: "text_delta" } });
			now += 4_000;
			fire("message_end", { message: assistant(400) });
			fire("model_request_end");

			// Two overlapping tools spanning 10s of wall time in total.
			fire("tool_execution_start", { toolCallId: "a" });
			now += 2_000;
			fire("tool_execution_start", { toolCallId: "b" });
			now += 8_000;
			fire("tool_execution_end", { toolCallId: "a" });
			fire("tool_execution_end", { toolCallId: "b" });

			fire("agent_end", { messages: [assistant(400)] });
		} finally {
			Date.now = realNow;
		}

		expect(notices).toEqual([
			"TPS 66.7 tok/s (400 tok in 6.0s of requests) · TTFT p50 2.0s max 2.0s · " +
				"tools 10.0s · 1 req · out 400, in 1,000, total 1,400 · loop 16.0s",
		]);
	});

	it("preserves foreground timing when a background request has no completion", () => {
		const { fire, notices } = createEventHarness();
		let now = 1_000;
		const realNow = Date.now;
		Date.now = () => now;

		try {
			fire("agent_start");
			fire("model_request_start"); // Foreground request starts at 1.0s.
			now += 2_000;
			fire("message_update", { assistantMessageEvent: { type: "text_delta" } }); // First token at 3.0s.
			now += 1_000;
			fire("before_provider_request"); // Background request starts at 4.0s; it has no message_end.
			now += 3_000;
			fire("message_end", { message: assistant(400) }); // Foreground request completes at 7.0s.
			fire("model_request_end");
			fire("agent_end", { messages: [assistant(400)] });
		} finally {
			Date.now = realNow;
		}

		expect(notices).toEqual([
			"TPS 66.7 tok/s (400 tok in 6.0s of requests) · TTFT p50 2.0s max 2.0s · " +
				"1 req · out 400, in 1,000, total 1,400 · loop 6.0s",
		]);
	});
});
