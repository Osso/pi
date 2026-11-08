import { runSupervisorService } from "../../../src/supervisor/main.ts";

// The model provider comes only from the agent dir's configured extension; no network is involved.
globalThis.fetch = async () => {
	throw new Error("Supervisor extension-provider regression forbids network requests");
};
await runSupervisorService();
