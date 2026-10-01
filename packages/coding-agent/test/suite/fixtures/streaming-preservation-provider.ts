import { createConnection, type Socket } from "node:net";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	StreamOptions,
} from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { createFauxCore } from "../../../../ai/src/providers/faux.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

function waitForInterruption(signal: AbortSignal | undefined): Promise<void> {
	if (!signal) return Promise.reject(new Error("Streaming regression requires an abort signal"));
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const abort = () => {
			clearTimeout(timeout);
			resolve();
		};
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			reject(new Error("Streaming interruption barrier timed out"));
		}, 10_000);
		signal.addEventListener("abort", abort, { once: true });
	});
}

interface PendingResponse {
	resolve: (message: AssistantMessage) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
}

function resolveSocketResponse(line: string, pending: Map<string, PendingResponse>): void {
	if (!line) return;
	const response = JSON.parse(line) as { requestId: string; message: AssistantMessage };
	const waiter = pending.get(response.requestId);
	if (!waiter) return;
	pending.delete(response.requestId);
	waiter.cleanup();
	waiter.resolve(response.message);
}

function rejectPendingResponses(pending: Map<string, PendingResponse>, error: Error): void {
	for (const waiter of pending.values()) {
		waiter.cleanup();
		waiter.reject(error);
	}
	pending.clear();
}

function subscribeToSocketResponses(socket: Socket, pending: Map<string, PendingResponse>): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		while (buffer.includes("\n")) {
			const end = buffer.indexOf("\n");
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			resolveSocketResponse(line, pending);
		}
	});
	socket.on("error", (error) => rejectPendingResponses(pending, error));
	socket.on("close", () => rejectPendingResponses(pending, new Error("Streaming provider socket closed")));
}

function waitForSocketResponse(
	pending: Map<string, PendingResponse>,
	id: string,
	signal: AbortSignal | undefined,
): Promise<AssistantMessage> {
	return new Promise<AssistantMessage>((resolve, reject) => {
		const abort = () => {
			pending.delete(id);
			reject(new Error("aborted"));
		};
		const cleanup = () => signal?.removeEventListener("abort", abort);
		pending.set(id, { resolve, reject, cleanup });
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}

function connectSocketResponder(socketPath: string) {
	const socket = createConnection(socketPath);
	const pending = new Map<string, PendingResponse>();
	let nextId = 1;
	subscribeToSocketResponses(socket, pending);
	return (context: Context, options: StreamOptions | undefined): Promise<AssistantMessage> => {
		const id = `stream_${nextId++}`;
		const response = waitForSocketResponse(pending, id, options?.signal);
		socket.write(
			`${JSON.stringify({ type: "request", id, sessionId: options?.sessionId, messages: context.messages, tools: context.tools })}\n`,
		);
		return response;
	};
}

async function endStreamAfterInterruption(
	output: AssistantMessageEventStream,
	partial: AssistantMessage,
	signal: AbortSignal | undefined,
): Promise<void> {
	try {
		await waitForInterruption(signal);
	} catch (error) {
		const failure = { ...partial, stopReason: "error" as const, errorMessage: String(error) };
		output.push({ type: "error", reason: "error", error: failure });
		output.end(failure);
		return;
	}
	const aborted = { ...partial, stopReason: "aborted" as const };
	output.push({ type: "error", reason: "aborted", error: aborted });
	output.end(aborted);
}

async function forwardStreamWithFirstToolBarrier(
	input: AssistantMessageEventStream,
	output: AssistantMessageEventStream,
	state: { callCount: number },
	signal: AbortSignal | undefined,
): Promise<void> {
	for await (const event of input) {
		output.push(event);
		if (event.type !== "toolcall_delta" || state.callCount !== 1) continue;
		await endStreamAfterInterruption(output, event.partial, signal);
		return;
	}
	output.end();
}

export default function registerStreamingProvider(pi: ExtensionAPI): void {
	const socketPath = process.env.PI_HEADLESS_PROVIDER_SOCKET;
	if (!socketPath) throw new Error("PI_HEADLESS_PROVIDER_SOCKET is required");
	const requestResponse = connectSocketResponder(socketPath);
	const faux = createFauxCore({
		api: "headless-faux",
		provider: "headless-faux",
		tokenSize: { min: 1, max: 1 },
	});
	const respond = (context: Context, options: StreamOptions | undefined): Promise<AssistantMessage> => {
		faux.appendResponses([respond]);
		return requestResponse(context, options);
	};
	faux.setResponses([respond]);
	pi.registerProvider("headless-faux", {
		api: faux.api,
		streamSimple: (model, context, options) => {
			const output = createAssistantMessageEventStream();
			const input = faux.streamSimple(model, context, options);
			void forwardStreamWithFirstToolBarrier(input, output, faux.state, options?.signal);
			return output;
		},
	});
}
