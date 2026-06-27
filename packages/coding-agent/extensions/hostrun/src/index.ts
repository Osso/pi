import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { highlightCode, type Theme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHostrunEvalExecutor } from "./eval-tool.ts";
import { HostrunRunnerClient } from "./runner.ts";

const HOSTRUN_PROMPT_SNIPPET =
	"Evaluate synchronous JavaScript through the canonical Hostrun runtime adapter; do not use await";

const HOSTRUN_PROMPT_GUIDELINES = [
	"Hostrun evaluates synchronous JavaScript in a persistent QuickJS session; do not use await.",
	"Pi delegates Hostrun runtime semantics to the canonical Hostrun adapter; Pi does not implement helper behavior locally.",
	"Do not use MCP for Pi's built-in hostrun_eval path; use the adapter runner that links the Hostrun runtime.",
	"Hostrun keeps globalThis.ctx across later hostrun_eval calls in the same Pi session.",
	"Use Hostrun helpers such as host.cwd(), host.cd(path), cli.*, run.*, fs.*, http.*, rg.*, and fd.* directly.",
	"Do not compose shell strings for Hostrun command helpers; call argv-style helpers such as cli.git('status').text() or run.git('status').",
];

function formatHostrunDisplay(text: string, executed: string | undefined, theme: Theme): string {
	if (!executed || !text.startsWith(executed)) {
		return theme.fg("toolOutput", text);
	}

	const rest = text.slice(executed.length).replace(/^\n+/, "");
	const highlightedCode = highlightCode(executed, "javascript").join("\n");
	return rest ? `${highlightedCode}\n\n${theme.fg("toolOutput", rest)}` : highlightedCode;
}

function getExecutedCode(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const executed = (details as { executed?: unknown }).executed;
	return typeof executed === "string" ? executed : undefined;
}

export default function hostrunExtension(pi: ExtensionAPI) {
	const runner = new HostrunRunnerClient();
	const evaluate = createHostrunEvalExecutor(runner);

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
			const executed = getExecutedCode(result.details);
			text.setText(formatHostrunDisplay(output, executed, theme));
			return text;
		},
		execute: async (_toolCallId, params, _signal, onUpdate, ctx) => {
			onUpdate?.({
				content: [{ type: "text", text: params.code }],
				details: { executed: params.code, type: "running" },
			});
			return evaluate(params, ctx, onUpdate);
		},
	});
}
