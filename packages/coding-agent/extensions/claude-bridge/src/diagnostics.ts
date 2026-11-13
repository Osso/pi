import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { type AuthTraceProfile, createAuthStderrRecorder } from "./auth-trace.ts";
import { debugLogPath, diagLogPath } from "./log-paths.ts";

// --- Debug logging ---
// CLAUDE_BRIDGE_DEBUG=1 enables debug logging to the bridge log in pi's agent
// dir (log-paths.ts), not a fixed ~/.pi/agent.

export const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";

// Unique per module evaluation — confirms whether subagents share module state
export const moduleInstanceId = Math.random().toString(36).slice(2, 8);

export function debug(...args: unknown[]) {
	if (!DEBUG) return;
	const logPath = debugLogPath();
	try {
		mkdirSync(dirname(logPath), { recursive: true });
	} catch {
		/* ignore */
	}
	const ts = new Date().toISOString();
	const fmt = (a: unknown): string => {
		if (typeof a === "string") return a;
		if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ""}`;
		return JSON.stringify(a);
	};
	const msg = args.map(fmt).join(" ");
	appendFileSync(logPath, `[${ts}] [${moduleInstanceId}] ${msg}\n`);
}

// Per-query CLI debug capture. When CLAUDE_BRIDGE_DEBUG=1, ask the Claude Code
// CLI subprocess to write its own debug log to a file we choose, and also
// forward its stderr into our debug stream. Drops straight into the real SDK's
// Options — see @anthropic-ai/claude-agent-sdk sdk.d.ts:1245 (debug, debugFile,
// stderr). Without this, CC's internal view of the world is invisible to us
// and "No conversation found" / empty-error reports are unactionable.
let nextCliDebugSeq = 1;
export function makeCliDebugOptions(
	tag: string,
	profile?: AuthTraceProfile,
): { debug?: boolean; debugFile?: string; stderr?: (data: string) => void } {
	const traceStderr = profile ? createAuthStderrRecorder(profile) : undefined;
	if (!DEBUG) return traceStderr ? { stderr: traceStderr } : {};
	const seq = nextCliDebugSeq++;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const logDir = join(dirname(debugLogPath()), "cc-cli-logs");
	try {
		mkdirSync(logDir, { recursive: true });
	} catch {
		/* ignore */
	}
	const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
	debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
	return {
		debug: true,
		debugFile,
		stderr: (data: string) => {
			traceStderr?.(data);
			for (const line of data.split(/\r?\n/)) {
				if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
			}
		},
	};
}

/** Unconditional diagnostic dump — for "should never happen" paths. Creates pi's agent
 *  dir itself: callers run inside streamSimple, where a missing dir must not throw. */
export function diagDump(label: string, data: Record<string, unknown>) {
	const ts = new Date().toISOString();
	const entry = { ts, moduleInstanceId, label, ...data };
	const logPath = diagLogPath();
	mkdirSync(dirname(logPath), { recursive: true });
	appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
	debug(`DIAG: ${label} (see ${logPath})`);
}
