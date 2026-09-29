import type { getApiProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

export default function registerInteractivePtyFauxProvider(pi: ExtensionAPI): void {
	const provider = (
		globalThis as typeof globalThis & {
			interactivePtyFauxProvider?: ReturnType<typeof getApiProvider>;
		}
	).interactivePtyFauxProvider;
	if (!provider) throw new Error("Headless faux provider preload is missing");
	pi.registerProvider("headless-faux", {
		api: "headless-faux",
		streamSimple: provider.streamSimple,
	});
	if (process.env.PI_TEST_PTY_NOTIFICATIONS === "1") {
		pi.on("tool_result", (event, ctx) => {
			if (event.toolName !== "end_turn" || !ctx.hasUI) return;
			for (let index = 1; index <= 6; index++) ctx.ui.notify(`PTY notification ${index}`, "info");
		});
	}
}
