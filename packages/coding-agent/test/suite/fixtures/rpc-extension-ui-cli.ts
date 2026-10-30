import { main, runCliActionOrReportError } from "../../../src/main.ts";

await runCliActionOrReportError(() =>
	main(process.argv.slice(2), {
		extensionFactories: [
			(pi) => {
				pi.registerCommand("test-ui", {
					description: "Exercise RPC dialog responses",
					handler: async (_args, ctx) => {
						const confirmed = await ctx.ui.confirm("Confirm", "Proceed?");
						const value = await ctx.ui.input("Input");
						ctx.ui.notify(JSON.stringify({ confirmed, value: value ?? null }), "info");
					},
				});
			},
		],
	}),
);
