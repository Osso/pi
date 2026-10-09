import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream, getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";
import { main, runCliActionOrReportError } from "../../../src/main.ts";

// The existing headless preload owns IPC. Alias its faux stream, never the real Codex stream.
const faux = getApiProvider("headless-faux");
if (!faux) throw new Error("Headless faux provider preload required");
const fauxStream = faux.stream;
const codexApi = "openai-codex-responses";

function stampResponse(event: AssistantMessageEvent, model: Model<string>): void {
	let message: AssistantMessage;
	if ("partial" in event) message = event.partial;
	else if ("message" in event) message = event.message;
	else message = event.error;
	message.api = codexApi;
	message.provider = model.provider;
	message.model = model.id;
}

const stream: StreamFunction<string, StreamOptions> = (model, context, options) => {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (!agentDir) throw new Error("Isolated headless agent directory required");
	appendFileSync(
		join(agentDir, "restriction-provider-requests.jsonl"),
		`${JSON.stringify({
			api: model.api,
			provider: model.provider,
			model: model.id,
			tools: context.tools?.map((tool) => tool.name) ?? [],
			reasoning: (options as SimpleStreamOptions | undefined)?.reasoning,
			transport: options?.transport,
		})}\n`,
	);
	const output = createAssistantMessageEventStream();
	const source = fauxStream({ ...model, api: "headless-faux" }, context, options);
	void (async () => {
		for await (const event of source) {
			stampResponse(event, model);
			output.push(event);
		}
		output.end();
	})();
	return output;
};
registerApiProvider({ api: codexApi, stream, streamSimple: stream });

const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) throw new Error("Isolated headless agent directory required");
const modelsPath = join(agentDir, "models.json");
const models: { providers: Record<string, { api: string }> } = JSON.parse(readFileSync(modelsPath, "utf8"));
models.providers["openai-codex"].api = codexApi;
writeFileSync(modelsPath, JSON.stringify(models));
const settingsPath = join(agentDir, "settings.json");
const settings: Record<string, unknown> = JSON.parse(readFileSync(settingsPath, "utf8"));
// Keep the entire retry horizon shorter than the negative-observation window.
settings.retry = { enabled: true, maxRetries: 3, baseDelayMs: 25 };
writeFileSync(settingsPath, JSON.stringify(settings));
writeFileSync(
	join(agentDir, "extensions", "restriction-proof.ts"),
	`import { appendFileSync } from "node:fs";
import { Type } from "typebox";
export default function(pi) {
	pi.registerTool({
		name: "restriction_completed_effect",
		description: "Append one test-only completed effect",
		parameters: Type.Object({ path: Type.String() }),
		execute: async (_id, input) => {
			appendFileSync(input.path, "completed\\n");
			return { content: [{ type: "text", text: "effect completed" }], details: {} };
		},
	});
	pi.registerCommand("restriction-resume", {
		description: "Test extension continuation, not explicit human input",
		handler: async () => { pi.sendUserMessage("Continue the active request."); },
	});
	pi.registerCommand("restriction-branch", {
		description: "Test semantic context change while advisory is pending",
		handler: async () => { pi.sendMessage({ customType: "restriction-test-branch", content: "Context changed during advisory.", display: false }); },
	});
	pi.registerCommand("restriction-fork", {
		description: "Fork the original refusal without new human authorization",
		handler: async (_args, ctx) => {
			const refusal = ctx.sessionManager.getBranch().find((entry) =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error",
			);
			if (!refusal) throw new Error("Original refusal entry required");
			await ctx.fork(refusal.id, { position: "at" });
		},
	});
	pi.registerCommand("restriction-rewind", {
		description: "Rewind before budget consumption without new human authorization",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getBranch();
			const user = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (!user) throw new Error("Original user entry required");
			await ctx.navigateTree(user.id, { summarize: false });
		},
	});
}`,
);
// Identify only this test process; the test never invokes installed Pi or a real provider.
process.env.PI_CODING_AGENT = "true";
await runCliActionOrReportError(() => main(process.argv.slice(2)));
