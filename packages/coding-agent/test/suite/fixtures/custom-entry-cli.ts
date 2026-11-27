import { main, runCliActionOrReportError } from "../../../src/main.ts";

await runCliActionOrReportError(() =>
	main(process.argv.slice(2), {
		extensionFactories: [
			(pi) => {
				pi.registerCommand("status-entries", {
					description: "Append two status entries and one other custom entry",
					handler: async () => {
						pi.appendEntry("supervisor-status", { message: "Waiting for Supervisor…", displayId: "d1" });
						pi.appendEntry("other-entry", { value: 1 });
						pi.appendEntry("supervisor-status", { message: "Continue.", displayId: "d1" });
					},
				});
			},
		],
	}),
);
