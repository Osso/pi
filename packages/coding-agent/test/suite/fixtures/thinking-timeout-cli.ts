import { join } from "node:path";
import { AgentSession } from "../../../src/core/agent-session.ts";
import { main, runCliActionOrReportError } from "../../../src/main.ts";

const deadlineMs = Number(process.env.PI_HEADLESS_THINKING_DEADLINE_MS ?? "600");
if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new Error("Invalid headless thinking deadline");
process.env.PI_HEADLESS_PROVIDER_ABORT_LOG = join(process.cwd(), "provider-aborts.jsonl");

// Configure the existing deadline on every real main/child session, including restored children.
const startDeadline = Reflect.get(AgentSession.prototype, "_startThinkingPhaseDeadline") as (
	this: AgentSession,
) => void;
Object.defineProperty(AgentSession.prototype, "_startThinkingPhaseDeadline", {
	configurable: true,
	value(this: AgentSession) {
		Reflect.set(this, "_thinkingPhaseTimeoutMs", deadlineMs);
		startDeadline.call(this);
	},
});

await runCliActionOrReportError(() => main(process.argv.slice(2)));
