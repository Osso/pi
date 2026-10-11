import { existsSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

export default function registerNarrationWait(pi: ExtensionAPI): void {
	const startedPath = process.env.PI_TEST_NARRATION_STARTED;
	const releasePath = process.env.PI_TEST_NARRATION_RELEASE;
	if (!startedPath || !releasePath) throw new Error("Narration wait fixture paths are required");
	pi.registerTool({
		name: "narration_wait",
		label: "Narration wait",
		description: "Controlled long-running tool for narration presentation tests",
		parameters: Type.Object({}),
		execute: async (_id, _params, signal) => {
			writeFileSync(startedPath, "running");
			const deadline = Date.now() + 15_000;
			while (!existsSync(releasePath)) {
				if (signal?.aborted) throw new Error("Narration wait aborted");
				if (Date.now() >= deadline) throw new Error("Narration wait release timed out");
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			return { content: [{ type: "text", text: "Released narration wait" }], details: {} };
		},
	});
}
