import { existsSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

export default function registerHeldUsageTool(pi: ExtensionAPI): void {
	const release = process.env.PI_TEST_USAGE_RELEASE;
	if (!release) throw new Error("PI_TEST_USAGE_RELEASE is required");
	pi.registerTool({
		name: "held_usage_tool",
		label: "Held usage tool",
		description: "Remain pending until the isolated test releases this tool",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			writeFileSync(`${release}.started`, "started");
			try {
				while (!existsSync(release)) await setTimeout(20, undefined, { signal });
				signal?.throwIfAborted();
			} catch (error) {
				writeFileSync(`${release}.aborted`, "aborted");
				throw error;
			}
			writeFileSync(`${release}.completed`, "completed");
			return { content: [{ type: "text", text: "Held usage tool released" }], details: {} };
		},
	});
}
