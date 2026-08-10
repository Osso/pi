/**
 * TPS Extension
 *
 * Reports throughput for an agent loop, split into the parts that move independently:
 * time-to-first-token, streaming rate, and tool wall time.
 *
 * The blended `output / loop wall time` rate is kept last and labelled, because on its
 * own it conflates generation speed with prefill and tool execution.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Stream events carrying generated content; the first one marks first token. */
const CONTENT_DELTA_EVENTS = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

interface RequestTiming {
	startMs: number;
	/** Response headers received, before the stream is consumed. */
	headersMs?: number;
	/** First content delta, measured from headers received. */
	firstTokenMs?: number;
	/** First content delta until message end. */
	streamMs?: number;
	/** Generated tokens for this request, reasoning included. */
	outputTokens: number;
}

interface LoopStats {
	elapsedMs: number;
	requests: RequestTiming[];
	toolMs: number;
	input: number;
	output: number;
	totalTokens: number;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
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

/**
 * Streaming rate over the summed stream windows only. Excludes prefill, queueing, and
 * tool execution, so this is the number a provider service tier should move.
 */
function formatStreamRate(requests: RequestTiming[]): string | undefined {
	const streamed = requests.filter((request) => request.streamMs !== undefined);
	const streamMs = streamed.reduce((total, request) => total + (request.streamMs ?? 0), 0);
	const tokens = streamed.reduce((total, request) => total + request.outputTokens, 0);
	if (streamMs <= 0 || tokens <= 0) return undefined;
	return `gen ${(tokens / (streamMs / 1000)).toFixed(1)} tok/s (${tokens.toLocaleString()} tok in ${formatSeconds(streamMs)})`;
}

function formatTimeToFirstToken(requests: RequestTiming[]): string | undefined {
	const values = requests
		.map((request) => (request.firstTokenMs === undefined ? undefined : (request.headersMs ?? 0) + request.firstTokenMs))
		.filter((value): value is number => value !== undefined);
	const p50 = median(values);
	if (p50 === undefined) return undefined;
	return `TTFT p50 ${formatSeconds(p50)} max ${formatSeconds(Math.max(...values))}`;
}

/** Loop time spent neither in a provider request nor in a tool: hooks, rendering, approvals. */
function formatOverhead(stats: LoopStats): string | undefined {
	const requestMs = stats.requests.reduce(
		(total, request) => total + (request.headersMs ?? 0) + (request.firstTokenMs ?? 0) + (request.streamMs ?? 0),
		0,
	);
	const otherMs = stats.elapsedMs - requestMs - stats.toolMs;
	if (otherMs < 500) return undefined;
	return `other ${formatSeconds(otherMs)}`;
}

function formatStats(stats: LoopStats): string {
	const blendedRate = stats.output / (stats.elapsedMs / 1000);
	const parts = [
		formatStreamRate(stats.requests),
		formatTimeToFirstToken(stats.requests),
		stats.toolMs > 0 ? `tools ${formatSeconds(stats.toolMs)}` : undefined,
		formatOverhead(stats),
		`${stats.requests.length} req`,
		`out ${stats.output.toLocaleString()}, in ${stats.input.toLocaleString()}, total ${stats.totalTokens.toLocaleString()}`,
		`loop ${formatSeconds(stats.elapsedMs)} (${blendedRate.toFixed(1)} tok/s blended)`,
	];
	return `TPS ${parts.filter((part) => part !== undefined).join(" · ")}`;
}

export default function (pi: ExtensionAPI) {
	let agentStartMs: number | null = null;
	let requests: RequestTiming[] = [];
	let pending: RequestTiming | null = null;
	let toolMs = 0;
	let activeTools = 0;
	let toolWindowStartMs = 0;

	pi.on("agent_start", () => {
		agentStartMs = Date.now();
		requests = [];
		pending = null;
		toolMs = 0;
		activeTools = 0;
	});

	// Retries fire this again for the same message; the latest attempt is the one measured.
	pi.on("before_provider_request", () => {
		pending = { startMs: Date.now(), outputTokens: 0 };
	});

	pi.on("after_provider_response", () => {
		if (!pending) return;
		pending.headersMs = Date.now() - pending.startMs;
	});

	pi.on("message_update", (event) => {
		if (!pending || pending.firstTokenMs !== undefined) return;
		if (!CONTENT_DELTA_EVENTS.has(event.assistantMessageEvent.type)) return;
		pending.firstTokenMs = Date.now() - pending.startMs - (pending.headersMs ?? 0);
	});

	pi.on("message_end", (event) => {
		if (!pending || !isAssistantMessage(event.message)) return;
		if (pending.firstTokenMs !== undefined) {
			pending.streamMs = Date.now() - pending.startMs - (pending.headersMs ?? 0) - pending.firstTokenMs;
		}
		pending.outputTokens = event.message.usage.output || 0;
		requests.push(pending);
		pending = null;
	});

	// Tools can run concurrently, so accumulate the union of their spans, not the sum.
	pi.on("tool_execution_start", () => {
		if (activeTools === 0) toolWindowStartMs = Date.now();
		activeTools += 1;
	});

	pi.on("tool_execution_end", () => {
		if (activeTools === 0) return;
		activeTools -= 1;
		if (activeTools === 0) toolMs += Date.now() - toolWindowStartMs;
	});

	pi.on("agent_end", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (agentStartMs === null) return;

		const elapsedMs = Date.now() - agentStartMs;
		agentStartMs = null;
		if (elapsedMs <= 0) return;

		let input = 0;
		let output = 0;
		let totalTokens = 0;

		for (const message of event.messages) {
			if (!isAssistantMessage(message)) continue;
			input += message.usage.input || 0;
			output += message.usage.output || 0;
			totalTokens += message.usage.totalTokens || 0;
		}

		if (output <= 0) return;

		ctx.ui.notify(formatStats({ elapsedMs, requests, toolMs, input, output, totalTokens }), "info");
	});
}
