import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { highlightCode, type Theme } from "../../../src/modes/interactive/theme/theme.ts";
import { createPyrunEvalExecutor } from "./eval-tool.ts";
import { PyrunRunnerClient } from "./runner.ts";

const PYRUN_PROMPT_SNIPPET = "Evaluate Python through the canonical Pyrun JSONL runtime adapter";

const PYRUN_PROMPT_GUIDELINES = [
	"Pyrun evaluates Python code in a persistent Python session with a persistent ctx object.",
	"Pi delegates Python/Pyrun runtime semantics to the Pyrun JSONL runner; Pi does not implement helper behavior locally.",
	"Do not use MCP for Pi's built-in pyrun_eval path; use the JSONL runner boundary.",
	"Use Pyrun helpers directly: host, fs, cli, run, http, rg, fd, sqlite, kubectl, tools, text, seq, obj, and hr.",
	"Do not compose shell strings for Pyrun command helpers; call argv-style helpers instead.",
];

function formatPyrunDisplay(text: string, executed: string | undefined, isError: boolean, theme: Theme): string {
	if (!executed) {
		return theme.fg("toolOutput", text);
	}

	const highlightedCode = highlightCode(executed, "python").join("\n");
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

export default function pyrunExtension(pi: ExtensionAPI) {
	const runner = new PyrunRunnerClient();
	const evaluate = createPyrunEvalExecutor(runner);

	pi.registerTool({
		name: "pyrun_eval",
		label: "Pyrun Eval",
		description: "Evaluate Python/Pyrun code through the canonical Pyrun JSONL runtime adapter.",
		promptSnippet: PYRUN_PROMPT_SNIPPET,
		promptGuidelines: PYRUN_PROMPT_GUIDELINES,
		approvalRequired: true,
		parameters: Type.Object({
			code: Type.String({ description: "Python source to evaluate." }),
			session_id: Type.Optional(Type.String({ description: "Pyrun session id. Defaults to this Pi session." })),
		}),
		renderCall(_args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.bold("pyrun_eval"));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text ?? "")
				.join("\n");
			const executed = getExecutedCode(result.details) ?? getArgsCode(context.args);
			text.setText(formatPyrunDisplay(output, executed, context.isError, theme));
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
