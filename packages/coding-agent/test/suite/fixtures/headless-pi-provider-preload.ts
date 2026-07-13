import { createConnection } from "node:net";
import type { AssistantMessage, Context, StreamOptions } from "@earendil-works/pi-ai/compat";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";

const socketPath = process.env.PI_HEADLESS_PROVIDER_SOCKET;
if (!socketPath) {
	throw new Error("PI_HEADLESS_PROVIDER_SOCKET is required");
}

interface ProviderResponse {
	type: "response";
	requestId: string;
	message: AssistantMessage;
}

const socket = createConnection(socketPath);
const pendingResponses = new Map<
	string,
	{ resolve: (message: AssistantMessage) => void; reject: (error: Error) => void }
>();
let inputBuffer = "";
let nextRequestId = 1;

socket.setEncoding("utf8");
socket.on("data", (chunk: string) => {
	inputBuffer += chunk;
	while (true) {
		const newlineIndex = inputBuffer.indexOf("\n");
		if (newlineIndex === -1) return;
		const line = inputBuffer.slice(0, newlineIndex);
		inputBuffer = inputBuffer.slice(newlineIndex + 1);
		if (!line) continue;
		const response = JSON.parse(line) as ProviderResponse;
		const pending = pendingResponses.get(response.requestId);
		if (!pending) continue;
		pendingResponses.delete(response.requestId);
		pending.resolve(response.message);
	}
});

function rejectPendingResponses(error: Error): void {
	for (const pending of pendingResponses.values()) pending.reject(error);
	pendingResponses.clear();
}

socket.on("error", (error) => rejectPendingResponses(error));
socket.on("close", () => rejectPendingResponses(new Error("Headless faux-provider IPC closed")));

function waitForParentResponse(context: Context, options: StreamOptions | undefined): Promise<AssistantMessage> {
	const requestId = `llm_${nextRequestId++}`;
	const response = new Promise<AssistantMessage>((resolve, reject) => {
		pendingResponses.set(requestId, { resolve, reject });
	});
	socket.write(
		`${JSON.stringify({
			type: "request",
			id: requestId,
			sessionId: options?.sessionId,
			messages: context.messages,
			tools: context.tools,
		})}\n`,
	);
	return response;
}

const provider = registerFauxProvider({
	api: "headless-faux",
	provider: "headless-faux",
	models: [{ id: "headless-faux-1", name: "Headless Faux" }],
});
async function receiveResponse(context: Context, options: StreamOptions | undefined): Promise<AssistantMessage> {
	provider.appendResponses([receiveResponse]);
	return waitForParentResponse(context, options);
}
provider.setResponses([receiveResponse]);
