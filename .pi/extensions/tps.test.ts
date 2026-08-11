// .pi is outside every package's vitest root, so run this explicitly:
//   npx --prefix packages/coding-agent vitest run --dir "$PWD/.pi"
import { describe, expect, it } from "vitest";
import registerTps, { formatStats, type LoopStats, type Span, unionMs } from "./tps.ts";

function loopStats(overrides: Partial<LoopStats>): LoopStats {
	return { elapsedMs: 0, requests: [], toolSpans: [], input: 0, output: 0, totalTokens: 0, ...overrides };
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
	it("reports TPS over full request time and decode over the stream window", () => {
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

		// TPS 800 tok / 12s of requests; decode 800 tok / 8s of streaming.
		expect(formatStats(stats)).toBe(
			"TPS 66.7 tok/s (800 tok in 12.0s of requests) · TTFT p50 2.0s max 2.0s · decode 100.0 tok/s · " +
				// other = 45.0s loop - 12.0s requests - 30.0s tools, i.e. the 1.0s and 2.0s gaps.
				"tools 30.0s · other 3.0s · 2 req · out 800, in 2,000, total 2,800 · loop 45.0s",
		);
	});

	it("keeps concurrent provider requests from exceeding loop wall time", () => {
		const stats = loopStats({
			elapsedMs: 16_400,
			// A background request overlaps the foreground one; summing would give 17.9s > loop.
			requests: [
				{ startMs: 0, firstTokenAtMs: 3_600, endMs: 10_000, outputTokens: 300 },
				{ startMs: 5_000, firstTokenAtMs: 10_100, endMs: 15_000, outputTokens: 310 },
			],
			input: 35_367,
			output: 610,
			totalTokens: 81_801,
		});

		// Union of requests is 15.0s, not 10.0s + 10.0s.
		expect(formatStats(stats)).toContain("TPS 40.7 tok/s (610 tok in 15.0s of requests)");
		expect(formatStats(stats)).toContain("loop 16.4s");
	});

	it("omits decode, tools and overhead when there is nothing to report", () => {
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
	it("measures a loop from provider and tool events", () => {
		const handlers = new Map<string, (event: any, ctx: any) => void>();
		const notices: string[] = [];
		const ctx = { hasUI: true, ui: { notify: (message: string) => notices.push(message) } };

		let now = 1_000;
		const realNow = Date.now;
		Date.now = () => now;

		try {
			registerTps({ on: (event: string, handler: any) => handlers.set(event, handler) } as any);
			const fire = (event: string, payload: Record<string, unknown> = {}) =>
				handlers.get(event)?.({ type: event, ...payload }, ctx);
			const assistant = (output: number) => ({ role: "assistant", usage: { input: 1_000, output, totalTokens: 1_000 + output } });

			fire("agent_start");
			fire("before_provider_request");
			now += 2_000;
			fire("message_update", { assistantMessageEvent: { type: "text_delta" } });
			now += 4_000;
			fire("message_end", { message: assistant(400) });

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
			"TPS 66.7 tok/s (400 tok in 6.0s of requests) · TTFT p50 2.0s max 2.0s · decode 100.0 tok/s · " +
				"tools 10.0s · 1 req · out 400, in 1,000, total 1,400 · loop 16.0s",
		]);
	});
});
