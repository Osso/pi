import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { Type } from "typebox";
import { createHostrunEvalExecutor } from "./eval-tool.ts";
import { HostrunSessionStore } from "./session.ts";

const HOSTRUN_PROMPT_SNIPPET =
	"Evaluate synchronous JavaScript in a persistent Hostrun ctx with approval-gated host helpers; do not use await";

const HOSTRUN_PROMPT_GUIDELINES = [
	"Hostrun evaluates synchronous JavaScript in a persistent QuickJS session; do not use await.",
	"Hostrun keeps globalThis.ctx across later hostrun_eval calls in the same Pi session.",
	"Use Hostrun helpers such as host.cwd(), host.cd(path), cli.*, run.*, fs.*, http.*, rg.*, and fd.* directly; they are approval-gated before host effects run.",
	"Do not compose shell strings for Hostrun command helpers; call argv-style helpers such as cli.git('status').text() or run.git('status').",
];

export default function hostrunExtension(pi: ExtensionAPI) {
	const store = new HostrunSessionStore();
	const evaluate = createHostrunEvalExecutor(store);

	pi.registerTool({
		name: "hostrun_eval",
		label: "Hostrun Eval",
		description: "Evaluate JavaScript in a persistent Hostrun session.",
		promptSnippet: HOSTRUN_PROMPT_SNIPPET,
		promptGuidelines: HOSTRUN_PROMPT_GUIDELINES,
		approvalRequired: false,
		parameters: Type.Object({
			code: Type.String({ description: "JavaScript source to evaluate." }),
			session_id: Type.Optional(Type.String({ description: "Hostrun session id. Defaults to this Pi session." })),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => evaluate(params, ctx),
	});
}
