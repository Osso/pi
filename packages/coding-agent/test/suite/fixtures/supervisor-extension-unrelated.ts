import { Type } from "typebox";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";

// A configured extension that registers no Supervisor provider; none of it may reach the Supervisor session.
export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\nUNRELATED-EXTENSION-MARKER` }));
	pi.registerTool({
		name: "unrelated_probe_tool",
		label: "Unrelated probe",
		description: "Must not reach the Supervisor tool surface",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "probe" }], details: {} }),
	});
}
