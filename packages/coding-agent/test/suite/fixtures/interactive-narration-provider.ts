import "./headless-pi-provider-preload.ts";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

export default function registerNarrationProvider(pi: ExtensionAPI): void {
	const provider = getApiProvider("headless-faux");
	if (!provider) throw new Error("Narration faux provider was not registered");
	pi.registerProvider("headless-faux", { api: "headless-faux", streamSimple: provider.streamSimple });
}
