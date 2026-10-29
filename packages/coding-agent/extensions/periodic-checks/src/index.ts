import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { parseFrontmatter } from "../../../src/utils/frontmatter.ts";

const maxTimerMs = 2147483647;
const millisecondsPerSecond = 1000;
const millisecondsPerMinute = 60 * millisecondsPerSecond;
const auditName = "periodic-checks-audit";
const terminalStates = new Set(["completed", "failed", "aborted"]);
const gitTimeoutMs = 5000;
const gitMaxBuffer = 64 * 1024;

function parseChecklistInterval(content: string): number {
	const header = /^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/.exec(content);
	if (!header) throw new Error("Missing or malformed YAML frontmatter");
	const { frontmatter } = parseFrontmatter(header[0]);
	if (typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
		throw new Error("YAML frontmatter must be a mapping");
	}
	if (typeof frontmatter.type !== "string" || !frontmatter.type.trim()) {
		throw new Error("type must be a nonempty string");
	}
	const seconds = frontmatter.interval_seconds;
	if (typeof seconds !== "number" || !Number.isSafeInteger(seconds)) {
		throw new Error("interval_seconds must be a positive finite safe integer");
	}
	const delay = seconds * millisecondsPerSecond;
	if (seconds <= 0 || delay > maxTimerMs) {
		throw new Error(`interval_seconds must yield timer milliseconds in 1..${maxTimerMs}`);
	}
	return delay;
}

function formatRemainingTime(remainingMs: number): string {
	if (remainingMs < millisecondsPerMinute) return "in less than a minute";
	const minutes = Math.ceil(remainingMs / millisecondsPerMinute);
	return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function readChecklistInterval(checklist: string): number {
	try {
		return parseChecklistInterval(readFileSync(checklist, "utf8"));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid periodic checks metadata at ${checklist}: ${reason}`, {
			cause: error,
		});
	}
}

function queryProjectRoot(cwd: string): string | undefined {
	const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		encoding: "utf8",
		timeout: gitTimeoutMs,
		maxBuffer: gitMaxBuffer,
	});
	if (git.error) {
		throw new Error(`Cannot discover Git project root at ${cwd}`, {
			cause: git.error,
		});
	}
	if (git.status !== 0) return undefined;
	return git.stdout.trim() || undefined;
}

function auditDisabledReason(pi: ExtensionAPI, ctx: ExtensionContext): string | undefined {
	if (ctx.multiAgentAgentId || ctx.multiAgentRequiresAgentId) return "Child session";
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return `Unsupported runtime mode: ${ctx.mode}`;
	if (!ctx.multiAgentStore) return "Missing multi-agent runtime store";
	const tools = pi.getActiveTools();
	const missing = ["spawn_agent", "send_agent_message"].filter((name) => !tools.includes(name));
	return missing.length ? `Missing required tools: ${missing.join(", ")}` : undefined;
}

function hasLiveAudit(ctx: ExtensionContext): boolean {
	return Boolean(
		ctx.multiAgentStore?.listAgents().some((agent) => {
			return agent.displayName === auditName && !terminalStates.has(agent.lifecycle);
		}),
	);
}

function auditPrompt(checklist: string, parentSessionId: string): string {
	return [
		`Perform one read-only, bounded project audit. Reread the current project's checklist at ${JSON.stringify(checklist)} for this audit. Follow only the checklist; do not invent unrelated task scope.`,
		"Report this project's worktree/disk/build/error/delegation state and host headroom only as requested by the checklist. Count other agents and resource usage when requested. Report missing checklist or unavailable evidence explicitly.",
		"Monitor report only: no nested spawn, no cleanup, no blocking, no cancellation, no steering, no edits or deployment, no builds, no operational mutation. Do not cancel audit children or restart main.",
		`Send child findings through send_agent_message with toAgentId "main" AND toSessionId ${JSON.stringify(parentSessionId)}, the originating parent session ID. Check the tool result and confirm successful delivery; a failed tool call is not delivery. Report delivery failure explicitly; no wait_agent recovery.`,
	].join("\n");
}

function assertAuditDispatched(result: Awaited<ReturnType<ExtensionAPI["callTool"]>>): void {
	const details = result.details;
	const dispatched =
		typeof details === "object" && details !== null && "dispatched" in details && details.dispatched === true;
	if (!result.isError && dispatched) return;
	const reason = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	throw new Error(`Audit was not dispatched: ${reason}`);
}

type ScheduledAudit = {
	projectRoot: string;
	checklist: string;
	sessionId: string;
	generation: number;
};

export default function periodicExtension(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let generation = 0;
	let inFlight = false;
	let scheduledAudit: ScheduledAudit | undefined;
	let checklist: string | undefined;
	let intervalMs: number | undefined;
	let nextTick: number | undefined;
	let disabledReason = "Session not started";

	function stopTimer(reason: string): void {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
		scheduledAudit = undefined;
		intervalMs = undefined;
		nextTick = undefined;
		disabledReason = reason;
		inFlight = false;
		generation++;
	}

	function advanceScheduledTick(now: number): void {
		if (intervalMs === undefined || nextTick === undefined) return;
		if (now < nextTick) return;
		const elapsedIntervals = Math.floor((now - nextTick) / intervalMs) + 1;
		nextTick += elapsedIntervals * intervalMs;
	}

	function dispatchAuditTick(ctx: ExtensionContext, audit: ScheduledAudit): void {
		if (audit.generation !== generation) return;
		advanceScheduledTick(Date.now());
		try {
			dispatchAudit(ctx, audit);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
			ctx.ui.notify(`Periodic audit refused for session ${audit.sessionId}: ${reason}${cause}`, "error");
		}
	}

	function dispatchAudit(ctx: ExtensionContext, audit: ScheduledAudit, manual = false): string | undefined {
		const reason = enforceDispatchGate(ctx, audit);
		if (reason) return reason;
		inFlight = true;
		if (manual) ctx.ui.notify("Periodic audit starting", "info");
		void spawnAudit(ctx, audit, manual);
		return undefined;
	}

	function enforceDispatchGate(ctx: ExtensionContext, audit: ScheduledAudit): string | undefined {
		if (!existsSync(audit.checklist)) {
			stopTimer("Checklist removed");
			return "Checklist removed";
		}
		if (inFlight) return "Audit already starting";
		if (ctx.sessionManager.getSessionId() !== audit.sessionId) return "Session identity changed";
		const unsupportedReason = auditDisabledReason(pi, ctx);
		if (unsupportedReason) return unsupportedReason;
		if (queryProjectRoot(ctx.cwd) !== audit.projectRoot) return "Project changed";
		if (hasLiveAudit(ctx)) return "Audit already live";
		return undefined;
	}

	function runManualAudit(ctx: ExtensionContext): void {
		const reason = scheduledAudit ? dispatchAudit(ctx, scheduledAudit, true) : disabledReason;
		if (reason) ctx.ui.notify(`Cannot run periodic audit: ${reason}`, "warning");
	}

	function isCurrentAudit(ctx: ExtensionContext, audit: ScheduledAudit): boolean {
		return audit.generation === generation && ctx.sessionManager.getSessionId() === audit.sessionId;
	}

	async function spawnAudit(ctx: ExtensionContext, audit: ScheduledAudit, manual: boolean): Promise<void> {
		try {
			const result = await pi.callTool("spawn_agent", {
				agentType: "explore",
				context: "fresh",
				displayName: auditName,
				prompt: auditPrompt(audit.checklist, audit.sessionId),
			});
			assertAuditDispatched(result);
			if (!isCurrentAudit(ctx, audit)) return;
			if (manual) ctx.ui.notify("Periodic audit started", "info");
		} catch (error) {
			if (!isCurrentAudit(ctx, audit)) return;
			const reason = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(
				`Periodic audit spawn_agent failed for session ${audit.sessionId} at ${audit.checklist}: ${reason}`,
				"error",
			);
		} finally {
			if (audit.generation === generation) inFlight = false;
		}
	}

	function startTimer(ctx: ExtensionContext): void {
		stopTimer("Session starting");
		checklist = undefined;
		const unsupportedReason = auditDisabledReason(pi, ctx);
		disabledReason = unsupportedReason ?? "Not a Git project";
		if (unsupportedReason) return;
		try {
			const projectRoot = queryProjectRoot(ctx.cwd);
			if (!projectRoot) return;
			checklist = join(projectRoot, "periodic-checks.md");
			disabledReason = "No checklist";
			if (!existsSync(checklist)) return;
			armTimer(ctx, projectRoot, checklist);
		} catch (error) {
			disabledReason = error instanceof Error ? error.message : String(error);
			throw error;
		}
	}

	function armTimer(ctx: ExtensionContext, projectRoot: string, path: string): void {
		intervalMs = readChecklistInterval(path);
		nextTick = Date.now() + intervalMs;
		const audit = {
			projectRoot,
			checklist: path,
			sessionId: ctx.sessionManager.getSessionId(),
			generation,
		};
		scheduledAudit = audit;
		timer = setInterval(() => dispatchAuditTick(ctx, audit), intervalMs);
	}

	function notifyStatus(ctx: ExtensionContext): void {
		const lines = [`Periodic checks: ${timer === undefined ? "disabled" : "armed"}`];
		if (checklist) lines.push(`Checklist: ${checklist}`);
		if (timer !== undefined && intervalMs !== undefined && nextTick !== undefined) {
			lines.push(`interval_seconds: ${intervalMs / millisecondsPerSecond}`);
			lines.push(`Next run: ${formatRemainingTime(nextTick - Date.now())}`);
		} else {
			lines.push(`Reason: ${disabledReason}`);
		}
		ctx.ui.notify(lines.join("\n"), "info");
	}

	pi.registerCommand("periodic-checks", {
		description: "Show periodic checklist scheduler status or run an audit",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "run") {
				runManualAudit(ctx);
				return;
			}
			if (action !== "" && action !== "status") {
				ctx.ui.notify("Usage: /periodic-checks status|run", "warning");
				return;
			}
			if (timer === undefined && disabledReason === "No checklist") startTimer(ctx);
			notifyStatus(ctx);
		},
	});

	pi.on("session_shutdown", () => stopTimer("Session shutdown"));
	pi.on("session_start", (_event, ctx) => startTimer(ctx));
}
