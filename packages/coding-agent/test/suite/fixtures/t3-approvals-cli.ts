import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { main, runCliActionOrReportError } from "../../../src/main.ts";

const extensionPath = process.env.T3_PI_MCP_EXTENSION_PATH;
if (!extensionPath) throw new Error("T3 approval fixture requires the injected extension path");
const gates: ExtensionFactory[] = process.env.PI_T3_TEST_DENY_WRITES
	? [
			(pi) =>
				pi.registerToolGate((event) =>
					event.toolName === "write" ? { block: true, reason: "Test capability restriction" } : undefined,
				),
		]
	: [];
await runCliActionOrReportError(() =>
	main([...process.argv.slice(2), "--extension", extensionPath], { extensionFactories: gates }),
);
