import { appendFileSync, writeFileSync } from "node:fs";
import { readProcessIdentity } from "../../../src/core/runtime-process.ts";
// Let dispatcher initialization recognize the guard as a deliberate fetch override.
import "../../../src/core/http-dispatcher.ts";

const reportPath = process.env.PI_SUPERVISOR_TEST_REPORT;
const logPath = process.env.PI_SUPERVISOR_TEST_LOG;
if (!reportPath || !logPath) throw new Error("Missing isolated Supervisor test report/log paths");

function report(event) {
	appendFileSync(reportPath, `${JSON.stringify(event)}\n`);
}

// Capture CLI startup diagnostics even though the production launcher ignores stdio.
for (const stream of [process.stdout, process.stderr]) {
	stream.write = (chunk, encoding, callback) => {
		appendFileSync(logPath, chunk, typeof encoding === "string" ? encoding : undefined);
		if (typeof encoding === "function") encoding();
		else if (callback) callback();
		return true;
	};
}
writeFileSync(logPath, "");
process.on("uncaughtExceptionMonitor", (error) => appendFileSync(logPath, `${error.stack ?? error}\n`));

let requests = 0;
function blockNetwork(transport) {
	requests += 1;
	report({ type: "request", transport });
	throw new Error(`Supervisor startup test forbids ${transport}`);
}
Object.defineProperty(globalThis, "fetch", {
	configurable: false,
	writable: false,
	value: async () => blockNetwork("fetch"),
});
Object.defineProperty(globalThis, "WebSocket", {
	configurable: false,
	writable: false,
	value: class {
		constructor() {
			blockNetwork("WebSocket");
		}
	},
});

const identity = readProcessIdentity(process.pid);
report({
	type: "started",
	identity,
	executable: process.execPath,
	bun: process.versions.bun ?? null,
});
process.on("exit", (code) => report({ type: "exit", identity, code, requests }));
