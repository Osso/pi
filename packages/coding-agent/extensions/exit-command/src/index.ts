import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("exit", {
		description: "Exit Pi cleanly",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
