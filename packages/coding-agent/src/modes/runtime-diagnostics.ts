// Runtime diagnostics reporting shared by the CLI startup path and every mode's session-replacement hook.
import chalk from "chalk";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import type { AgentSessionRuntimeDiagnostic } from "../core/agent-session-services.ts";

const reportedDiagnosticKeys = new WeakMap<AgentSessionRuntime, Set<string>>();

/**
 * Return the runtime's current diagnostics that were not taken before, and mark them taken.
 * The runtime factory runs again on every session replacement (/new, /resume, /fork, import), so a
 * diagnostic with the same type and message as an earlier one is left out instead of repeated.
 */
export function takeUnreportedDiagnostics(runtime: AgentSessionRuntime): AgentSessionRuntimeDiagnostic[] {
	let reported = reportedDiagnosticKeys.get(runtime);
	if (!reported) {
		reported = new Set();
		reportedDiagnosticKeys.set(runtime, reported);
	}
	const seen = reported;
	return runtime.diagnostics.filter((diagnostic) => {
		const key = `${diagnostic.type}\0${diagnostic.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Print each diagnostic to stderr as `Error: ...` (red), `Warning: ...` (yellow) or a dim info line. */
export function writeDiagnosticsToStderr(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}
