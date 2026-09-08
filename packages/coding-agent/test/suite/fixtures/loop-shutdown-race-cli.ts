import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { main, runCliActionOrReportError } from "../../../src/main.ts";

await runCliActionOrReportError(() =>
	main(process.argv.slice(2), {
		extensionFactories: [
			(pi) => {
				pi.on("session_shutdown", async (event, ctx) => {
					if (event.reason !== "new") return;
					const cwd = ctx.cwd;
					writeFileSync(join(cwd, "shutdown-entered"), ctx.sessionManager.getSessionId());
					const deadline = Date.now() + 10_000;
					while (!existsSync(join(cwd, "shutdown-release"))) {
						if (Date.now() >= deadline) throw new Error("Loop shutdown barrier was not released");
						await delay(10);
					}
				});
			},
		],
	}),
);
