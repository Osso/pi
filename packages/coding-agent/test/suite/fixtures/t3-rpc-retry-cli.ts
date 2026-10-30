import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main, runCliActionOrReportError } from "../../../src/main.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) throw new Error("T3 RPC retry fixture requires an isolated agent directory");
const settingsPath = join(agentDir, "settings.json");
const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
writeFileSync(
	settingsPath,
	JSON.stringify({ ...settings, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxBackoffMs: 1 } }),
);
await runCliActionOrReportError(() => main(process.argv.slice(2)));
