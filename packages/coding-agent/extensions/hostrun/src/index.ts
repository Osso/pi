import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { highlightCode, type Theme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHostrunEvalExecutor, type HostrunPiRequestDispatcher } from "./eval-tool.ts";
import { HostrunRunnerClient } from "./runner.ts";

export interface HostrunExtensionOptions {
	piRequestHandlers?: HostrunPiRequestDispatcher[];
}

const HOSTRUN_PROMPT_SNIPPET =
	"Evaluate synchronous JavaScript through the canonical Hostrun runtime adapter; do not use await";

const HOSTRUN_PROMPT_GUIDELINES = [
	"Hostrun evaluates synchronous JavaScript in a persistent QuickJS session; do not use await.",
	"Pi delegates Hostrun runtime semantics to the canonical Hostrun adapter; Pi does not implement helper behavior locally.",
	"Do not use MCP for Pi's built-in hostrun_eval path; use the adapter runner that links the Hostrun runtime.",
	"Hostrun keeps globalThis.ctx across later hostrun_eval calls in the same Pi session.",
	"Use pi.footer.snapshot() to read the current Pi footer snapshot inside Hostrun.",
	"Use pi.compact(...) to trigger Pi session compaction from Hostrun.",
	"Use pi.restart(...) to restart Pi and resume the same session from Hostrun.",
	"Use pi.agents.spawn(...), pi.agents.list(...), pi.agents.wait(...), and pi.messages.enqueue(...) for the supported Pi runtime bridge; pi.agents.wait(...) is synchronization-only and returns no agent output.",
	"Use Hostrun helpers such as host.cwd(), host.cd(path), cli.*, run.*, fs.*, http.*, rg.*, and fd.* directly.",
	"Do not compose shell strings for Hostrun command helpers; call argv-style helpers such as cli.git('status').text() or run.git('status').",
];

function formatHostrunDisplay(text: string, executed: string | undefined, isError: boolean, theme: Theme): string {
	if (!executed) {
		return theme.fg("toolOutput", text);
	}

	const highlightedCode = highlightCode(executed, "javascript").join("\n");
	if (!text.startsWith(executed)) {
		const prefix = isError && !text.startsWith("Error:") ? "Error: " : "";
		return `${highlightedCode}\n\n${theme.fg("toolOutput", `${prefix}${text}`)}`;
	}

	const rest = text.slice(executed.length).replace(/^\n+/, "");
	return rest ? `${highlightedCode}\n\n${theme.fg("toolOutput", rest)}` : highlightedCode;
}

function getExecutedCode(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const executed = (details as { executed?: unknown }).executed;
	return typeof executed === "string" ? executed : undefined;
}

function getArgsCode(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const code = (args as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function normalizeRestartParams(params: unknown): { notice?: string; process: true } {
	if (params === undefined || params === null) {
		return { process: true };
	}
	if (typeof params === "string") {
		return { notice: params, process: true };
	}
	if (typeof params !== "object") {
		throw new Error("pi.restart requires no argument, a notice string, or { notice } object");
	}
	const notice = (params as { notice?: unknown }).notice;
	if (notice !== undefined && typeof notice !== "string") {
		throw new Error("pi.restart notice must be a string");
	}
	return { notice, process: true };
}

function normalizeCompactParams(params: unknown): { customInstructions?: string } {
	if (params === undefined || params === null) {
		return {};
	}
	if (typeof params === "string") {
		return { customInstructions: params };
	}
	if (typeof params !== "object") {
		throw new Error("pi.compact requires no argument, a custom instructions string, or { customInstructions } object");
	}
	const customInstructions = (params as { customInstructions?: unknown }).customInstructions;
	if (customInstructions !== undefined && typeof customInstructions !== "string") {
		throw new Error("pi.compact customInstructions must be a string");
	}
	return { customInstructions };
}

function createHostrunPiDispatcher(pi: ExtensionAPI, options: HostrunExtensionOptions): HostrunPiRequestDispatcher {
	return async (request, ctx, signal) => {
		if (request.method === "compact") return triggerCompact(request.params, pi);
		if (request.method === "messages.enqueue") return enqueueMessage(request.params, pi);
		if (request.method === "restart") return triggerRestart(request.params, ctx);
		for (const handler of options.piRequestHandlers ?? []) {
			const result = await handler(request, ctx, signal);
			if (result !== undefined) return result;
		}
		throw new Error(`Pi capability is unavailable: ${request.method}`);
	};
}

function triggerCompact(params: unknown, pi: ExtensionAPI): { enqueued: true } {
	const options = normalizeCompactParams(params);
	const suffix = options.customInstructions ? ` ${options.customInstructions}` : "";
	pi.sendUserMessage(`/compact${suffix}`, { deliverAs: "followUp" });
	return { enqueued: true };
}

async function triggerRestart(params: unknown, ctx: ExtensionContext): Promise<{ started: true }> {
	await ctx.restart(normalizeRestartParams(params));
	return { started: true };
}

function enqueueMessage(params: unknown, pi: ExtensionAPI): { enqueued: true } {
	const message = normalizeMessageParams(params);
	pi.sendUserMessage(message.message, { deliverAs: message.deliverAs });
	return { enqueued: true };
}

function normalizeMessageParams(params: unknown): { deliverAs?: "steer" | "followUp"; message: string } {
	if (typeof params === "string") {
		return { message: params };
	}
	if (!params || typeof params !== "object") {
		throw new Error("pi.messages.enqueue requires a message string or { message } object");
	}
	const record = params as { deliverAs?: unknown; message?: unknown };
	if (typeof record.message !== "string") {
		throw new Error("pi.messages.enqueue requires a string message");
	}
	const deliverAs = record.deliverAs === "steer" || record.deliverAs === "followUp" ? record.deliverAs : undefined;
	return { deliverAs, message: record.message };
}

export default function hostrunExtension(pi: ExtensionAPI, options: HostrunExtensionOptions = {}) {
	const runner = new HostrunRunnerClient();
	const evaluate = createHostrunEvalExecutor(runner, createHostrunPiDispatcher(pi, options));

	pi.registerTool({
		name: "hostrun_eval",
		label: "Hostrun Eval",
		description: "Evaluate JavaScript through the canonical Hostrun runtime adapter.",
		promptSnippet: HOSTRUN_PROMPT_SNIPPET,
		promptGuidelines: HOSTRUN_PROMPT_GUIDELINES,
		approvalRequired: true,
		parameters: Type.Object({
			code: Type.String({ description: "JavaScript source to evaluate." }),
			session_id: Type.Optional(Type.String({ description: "Hostrun session id. Defaults to this Pi session." })),
		}),
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.bold("hostrun_eval"));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text ?? "")
				.join("\n");
			const executed = getExecutedCode(result.details) ?? getArgsCode(context.args);
			text.setText(formatHostrunDisplay(output, executed, context.isError, theme));
			return text;
		},
		execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
			onUpdate?.({
				content: [{ type: "text", text: params.code }],
				details: { executed: params.code, type: "running" },
			});
			return evaluate(params, ctx, onUpdate, signal);
		},
	});
}
