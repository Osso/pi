import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { Type } from "typebox";
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
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => evaluate(params, ctx),
	});
}
