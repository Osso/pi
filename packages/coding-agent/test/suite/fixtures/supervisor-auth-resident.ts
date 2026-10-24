import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { runSupervisorService } from "../../../src/supervisor/main.ts";

const reportPath = process.env.PI_SUPERVISOR_AUTH_REPORT;
if (!reportPath) throw new Error("PI_SUPERVISOR_AUTH_REPORT is required");

// No real provider implementation or OAuth endpoint is involved in this process.
globalThis.fetch = async () => {
	throw new Error("Supervisor auth regression forbids network requests");
};

const faux = registerFauxProvider({
	api: "supervisor-auth-faux",
	provider: "openai-codex-gc",
	models: [{ id: "gpt-6.1-sol", reasoning: true }],
});
const respond: Parameters<typeof faux.setResponses>[0][number] = (context, options, _state, model) => {
	faux.appendResponses([respond]);
	appendFileSync(
		reportPath,
		`${JSON.stringify({
			pid: process.pid,
			sessionId: options?.sessionId,
			apiKey: options?.apiKey,
			provider: model.provider,
			modelId: model.id,
			messages: context.messages,
		})}\n`,
	);
	if (options?.apiKey !== "fresh-unexpired-access") {
		return fauxAssistantMessage([], {
			stopReason: "error",
			errorMessage: "WebSocket 401: invalid access token",
		});
	}
	return fauxAssistantMessage(
		fauxToolCall("supervisor_response", {
			kind: "set",
			objective: "Preserve the full objective",
			reason: "Reviewed",
		}),
		{ stopReason: "toolUse" },
	);
};
faux.setResponses([respond]);
await runSupervisorService();
