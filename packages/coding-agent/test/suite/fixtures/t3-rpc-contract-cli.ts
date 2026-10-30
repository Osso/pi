import { main, runCliActionOrReportError } from "../../../src/main.ts";

await runCliActionOrReportError(() =>
	main(process.argv.slice(2), {
		extensionFactories: [
			(pi) => {
				let followUpSent = false;
				pi.registerCommand("t3-status", {
					description: "Exercise a command-only RPC prompt",
					handler: async (_args, ctx) => {
						ctx.ui.notify("T3 contract command completed", "info");
					},
				});
				pi.on("agent_end", () => {
					if (followUpSent) return;
					followUpSent = true;
					pi.sendUserMessage("T3 extension follow-up", { deliverAs: "followUp" });
				});
			},
		],
	}),
);
