import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { Type } from "typebox";
import { createHostrunEvalExecutor } from "./eval-tool.ts";
import { HostrunSessionStore } from "./session.ts";

export default function hostrunExtension(pi: ExtensionAPI) {
	const store = new HostrunSessionStore();
	const evaluate = createHostrunEvalExecutor(store);

	pi.registerTool({
		name: "hostrun_eval",
		label: "Hostrun Eval",
		description: "Evaluate JavaScript in a persistent Hostrun session.",
		parameters: Type.Object({
			code: Type.String({ description: "JavaScript source to evaluate." }),
			session_id: Type.Optional(Type.String({ description: "Hostrun session id. Defaults to this Pi session." })),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => evaluate(params, ctx),
	});
}
