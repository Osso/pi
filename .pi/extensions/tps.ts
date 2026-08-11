/**
 * TPS Extension
 *
 * Reports throughput for an agent loop.
 *
 * `TPS` is end-to-end foreground model-request throughput: generated tokens over the
 * full request wall time, including prefill and time-to-first-token. `loop` is the
 * total user-visible wall time.
 *
 * Foreground model requests are serialized. Tool spans are unioned because tools can
 * run concurrently.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Stream events carrying generated content; the first one marks first token. */
const CONTENT_DELTA_EVENTS = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

/** Overhead below this is noise, not a finding. */
const OVERHEAD_FLOOR_MS = 500;

export interface Span {
	startMs: number;
	endMs: number;
}

export interface RequestTiming {
	startMs: number;
	/** Absolute time of the first content delta, when the request produced one. */
	firstTokenAtMs?: number;
	endMs?: number;
	/** Generated tokens for this request, reasoning included. */
	outputTokens: number;
}

export interface LoopStats {
	elapsedMs: number;
	requests: RequestTiming[];
	toolSpans: Span[];
	input: number;
	output: number;
	totalTokens: number;
}

interface UsageTotals {
	input: number;
	output: number;
	totalTokens: number;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

function summarizeAssistantUsage(messages: readonly unknown[]): UsageTotals {
	return messages.reduce<UsageTotals>(
		(usage, message) => {
			if (!isAssistantMessage(message)) return usage;
			return {
				input: usage.input + (message.usage.input || 0),
				output: usage.output + (message.usage.output || 0),
				totalTokens: usage.totalTokens + (message.usage.totalTokens || 0),
			};
		},
		{ input: 0, output: 0, totalTokens: 0 },
	);
}

/** Wall time covered by at least one span. Overlapping spans are counted once. */
export function unionMs(spans: Span[]): number {
	const sorted = [...spans].filter((span) => span.endMs > span.startMs).sort((a, b) => a.startMs - b.startMs);
	let total = 0;
	let windowStart = 0;
	let windowEnd = -1;
	for (const span of sorted) {
		if (span.startMs > windowEnd) {
			if (windowEnd > windowStart) total += windowEnd - windowStart;
			windowStart = span.startMs;
			windowEnd = span.endMs;
			continue;
		}
		windowEnd = Math.max(windowEnd, span.endMs);
	}
	if (windowEnd > windowStart) total += windowEnd - windowStart;
	return total;
}

function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function completedRequests(requests: RequestTiming[]): Array<RequestTiming & { endMs: number }> {
	return requests.filter((request): request is RequestTiming & { endMs: number } => request.endMs !== undefined);
}

function requestSpans(requests: RequestTiming[]): Span[] {
	return completedRequests(requests).map((request) => ({ startMs: request.startMs, endMs: request.endMs }));
}

function formatRate(tokens: number, ms: number): string | undefined {
	if (tokens <= 0 || ms <= 0) return undefined;
	return `${(tokens / (ms / 1000)).toFixed(1)} tok/s`;
}

/** End-to-end throughput across complete foreground model requests. */
function formatThroughput(stats: LoopStats): string {
	const requestMs = requestSpans(stats.requests).reduce((total, span) => total + span.endMs - span.startMs, 0);
	const tokens = completedRequests(stats.requests).reduce((total, request) => total + request.outputTokens, 0);
	const rate = formatRate(tokens, requestMs);
	if (!rate) return "TPS n/a";
	return `TPS ${rate} (${tokens.toLocaleString()} tok in ${formatSeconds(requestMs)} of requests)`;
}

function formatTimeToFirstToken(requests: RequestTiming[]): string | undefined {
	const values = requests.flatMap((request) =>
		request.firstTokenAtMs === undefined ? [] : [request.firstTokenAtMs - request.startMs],
	);
	const p50 = median(values);
	if (p50 === undefined) return undefined;
	return `TTFT p50 ${formatSeconds(p50)} max ${formatSeconds(Math.max(...values))}`;
}

/** Loop time spent neither in a foreground model request nor in a tool. */
function formatOverhead(stats: LoopStats): string | undefined {
	const busyMs = unionMs([...requestSpans(stats.requests), ...stats.toolSpans]);
	const otherMs = stats.elapsedMs - busyMs;
	if (otherMs < OVERHEAD_FLOOR_MS) return undefined;
	return `other ${formatSeconds(otherMs)}`;
}

export function formatStats(stats: LoopStats): string {
	const toolMs = unionMs(stats.toolSpans);
	const parts = [
		formatThroughput(stats),
		formatTimeToFirstToken(stats.requests),
		toolMs > 0 ? `tools ${formatSeconds(toolMs)}` : undefined,
		formatOverhead(stats),
		`${stats.requests.length} req`,
		`out ${stats.output.toLocaleString()}, in ${stats.input.toLocaleString()}, total ${stats.totalTokens.toLocaleString()}`,
		`loop ${formatSeconds(stats.elapsedMs)}`,
	];
	return parts.filter((part) => part !== undefined).join(" · ");
}

export default function (pi: ExtensionAPI) {
	let agentStartMs: number | null = null;
	let requests: RequestTiming[] = [];
	let pending: RequestTiming | null = null;
	let toolSpans: Span[] = [];
	const toolStartMs = new Map<string, number>();

	pi.on("agent_start", () => {
		agentStartMs = Date.now();
		requests = [];
		pending = null;
		toolSpans = [];
		toolStartMs.clear();
	});

	pi.on("model_request_start", () => {
		pending = { startMs: Date.now(), outputTokens: 0 };
	});

	pi.on("message_update", (event) => {
		if (!pending || pending.firstTokenAtMs !== undefined) return;
		if (!CONTENT_DELTA_EVENTS.has(event.assistantMessageEvent.type)) return;
		pending.firstTokenAtMs = Date.now();
	});

	pi.on("message_end", (event) => {
		if (!pending || !isAssistantMessage(event.message)) return;
		pending.outputTokens = event.message.usage.output || 0;
	});

	pi.on("model_request_end", () => {
		if (!pending) return;
		pending.endMs = Date.now();
		requests.push(pending);
		pending = null;
	});

	pi.on("tool_execution_start", (event) => {
		toolStartMs.set(event.toolCallId, Date.now());
	});

	pi.on("tool_execution_end", (event) => {
		const startMs = toolStartMs.get(event.toolCallId);
		if (startMs === undefined) return;
		toolStartMs.delete(event.toolCallId);
		toolSpans.push({ startMs, endMs: Date.now() });
	});

	pi.on("agent_end", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (agentStartMs === null) return;

		const elapsedMs = Date.now() - agentStartMs;
		agentStartMs = null;
		if (elapsedMs <= 0) return;

		const usage = summarizeAssistantUsage(event.messages);
		if (usage.output <= 0) return;

		ctx.ui.notify(formatStats({ elapsedMs, requests, toolSpans, ...usage }), "info");
	});
}
