import "./headless-pi-provider-preload.ts";
import { getApiProvider } from "@earendil-works/pi-ai/compat";

const provider = getApiProvider("headless-faux");
if (!provider) throw new Error("Headless faux provider preload did not register");
(globalThis as typeof globalThis & { interactivePtyFauxProvider?: typeof provider }).interactivePtyFauxProvider =
	provider;
