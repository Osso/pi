import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	AgentEndEvent,
	AgentToolResult,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { type CompletionWaitScheduler, createCompletionWaitScheduler } from "./completion-scheduling.ts";
import { type EmptyResponseScheduler, createEmptyResponseScheduler } from "./empty-response-scheduling.ts";
import { type ErrorStatusScheduler, createErrorStatusScheduler } from "./error-status-scheduling.ts";
import { runScheduledGoalAgentEnd } from "./goal-agent-end-scheduling.ts";
import { parseGoalArgs } from "./goal-args.ts";
import { selectGoalForIdleReview } from "./goal-idle-selection.ts";
import { isRecord, optionalString, parseGoal, parseGoalJson } from "./goal-parsing.ts";
import { goalFooterStatus, goalStartupMessage, goalSystemBlock, goalViewMessage } from "./goal-presentation.ts";
import { type GoalScheduler, createGoalScheduler } from "./goal-scheduling.ts";
import type { Goal, GoalExtensionOptions, GoalSupervisorResponse, GoalSupervisorReview } from "./goal-types.ts";
import { type ManageGoalParams, registerManageGoalTool } from "./goal-tool.ts";
import {
	appendSupervisorStatus,
	renderSupervisorMessage,
	renderSupervisorStatusEntry,
	sendSupervisorInstructions,
} from "./rendering.ts";
import { reviewGoalWithResidentSupervisor } from "./supervisor-review.ts";

const MAX_OBJECTIVE_CHARS = 4000;
const RESERVED_GOAL_OBJECTIVES = new Set(["set", "pause", "resume", "clear", "status", "complete", "continue"]);

export type { Goal, GoalExtensionOptions, GoalSupervisorResponse, GoalSupervisorReview } from "./goal-types.ts";

interface SetGoalParams {
	objective: string;
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	beforeSave?: () => void;
}

interface ManageGoalContext {
	ctx: ExtensionContext;
	params: ManageGoalParams;
	pi: ExtensionAPI;
	reviewGoal: GoalSupervisorReview;
	onCompletionWait: (goal: Goal, ctx: ExtensionContext, reason: string) => Promise<void>;
	isCompletionReviewCurrent?: () => boolean;
	beforeGoalSave?: () => void;
}

function goalPathForSessionId(cwd: string, sessionId: string): string {
	return path.join(cwd, ".pi", "goals", `${encodeURIComponent(sessionId)}.json`);
}

function goalPath(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): string {
	return goalPathForSessionId(ctx.cwd, ctx.sessionManager.getSessionId());
}

function oldProjectGoalPath(cwd: string): string {
	return path.join(cwd, ".pi", "goal.json");
}

function saveGoalJson(ctx: Pick<ExtensionContext, "sessionManager">, goal: Goal): void {
	ctx.sessionManager.setSessionGoalJson(`${JSON.stringify(goal)}\n`);
}

function loadGoalFile(file: string): Goal | null {
	if (!fs.existsSync(file)) return null;
	try {
		return parseGoal(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		return null;
	}
}

function loadOrMigrateGoal(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): Goal | null {
	const storedGoal = ctx.sessionManager.getSessionGoalJson();
	if (storedGoal) return parseGoalJson(storedGoal);
	return migrateLegacyGoal(ctx);
}

function loadOrMigrateActiveGoal(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): Goal | null {
	const goal = loadOrMigrateGoal(ctx);
	return goal && !goal.completedAt ? goal : null;
}

function loadOrMigrateRunningGoal(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): Goal | null {
	const goal = loadOrMigrateActiveGoal(ctx);
	return goal && !goal.pausedAt ? goal : null;
}

function migrateLegacyGoal(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): Goal | null {
	for (const file of [goalPath(ctx), oldProjectGoalPath(ctx.cwd)]) {
		const goal = loadGoalFile(file);
		if (!goal) continue;
		saveGoalJson(ctx, goal);
		fs.rmSync(file);
		return goal;
	}
	return null;
}

function saveGoal(ctx: Pick<ExtensionContext, "sessionManager">, goal: Goal): void {
	saveGoalJson(ctx, goal);
}

function markGoalComplete(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, reason: string): Goal | null {
	const goal = loadOrMigrateActiveGoal(ctx);
	if (!goal) return null;
	const completedGoal: Goal = {
		...goal,
		completedAt: new Date().toISOString(),
		completionReason: reason,
	};
	saveGoal(ctx, completedGoal);
	return completedGoal;
}

function pauseGoal(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): Goal | null {
	const goal = loadOrMigrateActiveGoal(ctx);
	if (!goal) return null;
	if (goal.pausedAt) return goal;
	const pausedGoal: Goal = {
		...goal,
		pausedAt: new Date().toISOString(),
	};
	saveGoal(ctx, pausedGoal);
	return pausedGoal;
}

function resumeGoal(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): Goal | null {
	const goal = loadOrMigrateActiveGoal(ctx);
	if (!goal?.pausedAt) return null;
	const { pausedAt: _pausedAt, ...resumedGoal } = goal;
	saveGoal(ctx, resumedGoal);
	return resumedGoal;
}

function clearGoal(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): boolean {
	const hasStoredGoal = ctx.sessionManager.getSessionGoalJson() !== undefined;
	const legacyFile = goalPath(ctx);
	const hasLegacyGoal = fs.existsSync(legacyFile);
	ctx.sessionManager.clearSessionGoalJson();
	if (hasLegacyGoal) {
		fs.rmSync(legacyFile);
	}
	return hasStoredGoal || hasLegacyGoal;
}

function updateGoalFooterStatus(ctx: ExtensionContext): void {
	const goal = loadOrMigrateActiveGoal(ctx);
	ctx.ui.setStatus("goal", goal ? goalFooterStatus(goal) : undefined);
}

function readCurrentBranch(cwd: string): string {
	try {
		return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "(no branch)";
	}
}

function sessionIdFromSessionFile(sessionFile: string): string | null {
	try {
		const [firstLine] = fs.readFileSync(sessionFile, "utf8").split("\n", 1);
		const entry = JSON.parse(firstLine ?? "");
		return isRecord(entry) ? optionalString(entry.id) ?? null : null;
	} catch {
		return null;
	}
}

function isGoalInheritanceEvent(event: SessionStartEvent): event is SessionStartEvent & { previousSessionFile: string } {
	return event.reason === "fork" && Boolean(event.previousSessionFile);
}

function inheritPreviousSessionGoal(event: SessionStartEvent, ctx: ExtensionContext): void {
	if (!isGoalInheritanceEvent(event)) return;
	if (ctx.sessionManager.isSubagentSession()) return;
	if (loadOrMigrateGoal(ctx)) return;

	const previousGoalJson = ctx.sessionManager.getSessionGoalJsonForSession(event.previousSessionFile);
	const previousGoal = previousGoalJson ? parseGoalJson(previousGoalJson) : loadLegacyPreviousGoal(event, ctx);
	if (previousGoal && !previousGoal.completedAt) {
		saveGoal(ctx, previousGoal);
	}
}

function loadLegacyPreviousGoal(event: SessionStartEvent, ctx: ExtensionContext): Goal | null {
	if (!event.previousSessionFile) return null;
	const previousSessionId = sessionIdFromSessionFile(event.previousSessionFile);
	return previousSessionId ? loadGoalFile(goalPathForSessionId(ctx.cwd, previousSessionId)) : null;
}

function textResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

type SetGoalResult = { ok: boolean; message: string; severity: "error" | "info" | "warning"; goal?: Goal };

function validateGoalObjective(objective: string): SetGoalResult | undefined {
	if (RESERVED_GOAL_OBJECTIVES.has(objective.toLowerCase())) {
		return { ok: false, message: `Objective cannot be a goal control command: ${objective}`, severity: "error" };
	}
	if (objective.length > MAX_OBJECTIVE_CHARS) {
		return {
			ok: false,
			message: `Objective too long (${objective.length} > ${MAX_OBJECTIVE_CHARS} chars)`,
			severity: "error",
		};
	}
}

function createGoal(objective: string, branch: string, createdAt: string): Goal {
	return { objective, branch, createdAt, continuationTurns: 0 };
}

function setGoal(params: SetGoalParams): SetGoalResult {
	const invalidResult = validateGoalObjective(params.objective);
	if (invalidResult) return invalidResult;
	params.beforeSave?.();
	const goal = createGoal(params.objective, readCurrentBranch(params.ctx.cwd), new Date().toISOString());
	saveGoal(params.ctx, goal);
	updateGoalFooterStatus(params.ctx);
	const idle = params.ctx.isIdle();
	if (idle) params.pi.sendUserMessage("Continue working toward the active goal.");
	return {
		ok: true,
		message: idle ? "Goal set — starting work" : "Goal saved — it will guide the current run",
		severity: "info",
		goal,
	};
}

function runSetGoalAction({
	ctx,
	params,
	pi,
	beforeGoalSave,
}: Omit<ManageGoalContext, "reviewGoal" | "onCompletionWait">): AgentToolResult<unknown> {
	const objective = params.objective?.trim() ?? "";
	if (!objective) {
		return textResult("Objective is required.");
	}

	const result = setGoal({ objective, ctx, pi, beforeSave: beforeGoalSave });
	ctx.ui.notify(result.message, result.severity);
	const details = result.goal ? { objective: result.goal.objective } : {};
	return textResult(result.ok ? `Goal set: ${objective}` : result.message, details);
}

function runPauseGoalAction(ctx: ExtensionContext, afterGoalChange?: () => void): AgentToolResult<unknown> {
	const goal = pauseGoal(ctx);
	updateGoalFooterStatus(ctx);
	if (!goal) {
		ctx.ui.notify("No active goal to pause", "info");
		return textResult("No active goal to pause.");
	}

	afterGoalChange?.();
	ctx.ui.notify(`Goal paused: ${goal.objective}`, "info");
	return textResult(`Goal paused: ${goal.objective}`, { objective: goal.objective });
}

function runResumeGoalAction(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	afterGoalChange?: () => void,
): AgentToolResult<unknown> {
	const goal = resumeGoal(ctx);
	updateGoalFooterStatus(ctx);
	if (!goal) {
		ctx.ui.notify("No paused goal to resume", "info");
		return textResult("No paused goal to resume.");
	}

	afterGoalChange?.();
	ctx.ui.notify(`Goal resumed: ${goal.objective}`, "info");
	if (ctx.isIdle()) {
		pi.sendUserMessage("Continue working toward the active goal.");
	}
	return textResult(`Goal resumed: ${goal.objective}`, { objective: goal.objective });
}

function goalMatchesReview(currentGoal: Goal | null, reviewedGoal: Goal): boolean {
	return (
		currentGoal?.createdAt === reviewedGoal.createdAt &&
		currentGoal.objective === reviewedGoal.objective &&
		currentGoal.pausedAt === reviewedGoal.pausedAt
	);
}

async function applyCompletionDecision(
	decision: GoalSupervisorResponse,
	activeGoal: Goal,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	reason: string,
	onWait: (goal: Goal, ctx: ExtensionContext, reason: string) => Promise<void>,
): Promise<AgentToolResult<unknown>> {
	if (decision.kind === "continue") {
		sendSupervisorInstructions(pi, decision.instructions);
		return textResult(`Goal remains active: ${decision.reason}`, { instructions: decision.instructions });
	}
	if (decision.kind === "pause") return textResult(`Goal remains active: ${decision.reason}`);
	if (decision.kind === "wait") {
		appendSupervisorStatus(pi, `Waiting: ${decision.reason}`);
		await onWait(activeGoal, ctx, reason);
		return textResult(`Goal remains active: ${decision.reason}`);
	}
	if (decision.kind !== "complete") {
		appendSupervisorStatus(pi, `Goal review failed: ${decision.reason}`);
		ctx.ui.notify(`Supervisor goal review failed: ${decision.reason}`, "error");
		return textResult(`Goal review failed: ${decision.reason}`);
	}
	const goal = markGoalComplete(ctx, reason);
	if (!goal) return textResult("No active goal to complete.");
	updateGoalFooterStatus(ctx);
	ctx.ui.notify(`Goal complete: ${goal.objective}`, "info");
	return textResult(`Goal marked complete: ${reason}`);
}

async function runCompleteGoalAction(
	ctx: ExtensionContext,
	reasonInput: string | undefined,
	reviewGoal: GoalSupervisorReview,
	pi: ExtensionAPI,
	onWait: (goal: Goal, ctx: ExtensionContext, reason: string) => Promise<void>,
	isReviewCurrent: () => boolean,
): Promise<AgentToolResult<unknown>> {
	const activeGoal = loadOrMigrateActiveGoal(ctx);
	if (!activeGoal) return textResult("No active goal to complete.");
	const reason = reasonInput?.trim() || "complete";
	const decision = await reviewGoal({
		ctx,
		kind: "goal_completion_review",
		payload: { objective: activeGoal.objective, proposedCompletionReason: reason },
	});
	const reviewStillApplies = isReviewCurrent() && goalMatchesReview(loadOrMigrateActiveGoal(ctx), activeGoal);
	if (!reviewStillApplies) return textResult("Goal changed or review was canceled; stale decision ignored.");
	return applyCompletionDecision(decision, activeGoal, ctx, pi, reason, onWait);
}

function runClearGoalAction(ctx: ExtensionContext, afterGoalChange?: () => void): AgentToolResult<unknown> {
	const cleared = clearGoal(ctx);
	updateGoalFooterStatus(ctx);
	if (cleared) afterGoalChange?.();
	const message = cleared ? "Goal cleared" : "No active goal";
	ctx.ui.notify(message, "info");
	return textResult(message);
}

function runGoalStatusAction(ctx: ExtensionContext): AgentToolResult<unknown> {
	const goal = loadOrMigrateActiveGoal(ctx);
	const message = goal ? goalViewMessage(goal) : "No active goal — use /goal set <objective>";
	ctx.ui.notify(message, "info");
	const details = goal ? { objective: goal.objective } : {};
	return textResult(message, details);
}

async function manageGoal(context: ManageGoalContext): Promise<AgentToolResult<unknown>> {
	const { ctx, params, pi, beforeGoalSave } = context;
	switch (params.action) {
		case "set":
			return runSetGoalAction({ ctx, params, pi, beforeGoalSave });
		case "pause":
			return runPauseGoalAction(ctx, beforeGoalSave);
		case "resume":
			return runResumeGoalAction(ctx, pi, beforeGoalSave);
		case "complete":
			return runCompleteGoalAction(
				ctx,
				params.reason,
				context.reviewGoal,
				pi,
				context.onCompletionWait,
				context.isCompletionReviewCurrent ?? (() => true),
			);
		case "clear":
			return runClearGoalAction(ctx, beforeGoalSave);
		case "status":
			return runGoalStatusAction(ctx);
	}
}

function completeGoalFromIdleDecision(goal: Goal, reason: string, ctx: ExtensionContext): void {
	markGoalComplete(ctx, reason);
	updateGoalFooterStatus(ctx);
	ctx.ui.notify(`Goal complete: ${goal.objective}`, "info");
}

function continueGoalFromIdleDecision(goal: Goal, instructions: string, ctx: ExtensionContext, pi: ExtensionAPI): void {
	const continuationTurns = goal.continuationTurns ?? 0;
	saveGoal(ctx, { ...goal, continuationTurns: continuationTurns + 1 });
	sendSupervisorInstructions(pi, instructions);
}

async function reportGoalWait(
	pi: ExtensionAPI,
	prefix: "Waiting" | "Goal review failed",
	reason: string,
	onWait: (reason: string) => Promise<void>,
): Promise<void> {
	appendSupervisorStatus(pi, `${prefix}: ${reason}`);
	await onWait(reason);
}

async function applyGoalIdleDecision(
	decision: GoalSupervisorResponse,
	goal: Goal,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	onWait: (reason: string) => Promise<void>,
): Promise<void> {
	switch (decision.kind) {
		case "complete":
			return completeGoalFromIdleDecision(goal, decision.reason, ctx);
		case "pause":
			return appendSupervisorStatus(pi, `Goal waiting: ${decision.reason}`);
		case "wait":
			return reportGoalWait(pi, "Waiting", decision.reason, onWait);
		case "error":
			return reportGoalWait(pi, "Goal review failed", decision.reason, onWait);
		case "continue":
			return continueGoalFromIdleDecision(goal, decision.instructions, ctx, pi);
	}
}

function clearGoalRetry(ctx: ExtensionCommandContext, clearRetry: (sessionId: string) => void): void {
	clearRetry(ctx.sessionManager.getSessionId());
}

function handleGoalPauseCommand(ctx: ExtensionCommandContext, clearRetry: (sessionId: string) => void): void {
	const goal = pauseGoal(ctx);
	if (goal) clearGoalRetry(ctx, clearRetry);
	ctx.ui.notify(goal ? `Goal paused: ${goal.objective}` : "No active goal to pause", "info");
	updateGoalFooterStatus(ctx);
}

function handleGoalResumeCommand(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	clearRetry: (sessionId: string) => void,
): void {
	const goal = resumeGoal(ctx);
	if (goal) clearGoalRetry(ctx, clearRetry);
	ctx.ui.notify(goal ? `Goal resumed: ${goal.objective}` : "No paused goal to resume", "info");
	updateGoalFooterStatus(ctx);
	if (goal && ctx.isIdle()) pi.sendUserMessage("Continue working toward the active goal.");
}

function handleGoalClearCommand(ctx: ExtensionCommandContext, clearRetry: (sessionId: string) => void): void {
	const cleared = clearGoal(ctx);
	if (cleared) clearGoalRetry(ctx, clearRetry);
	ctx.ui.notify(cleared ? "Goal cleared" : "No active goal", "info");
	updateGoalFooterStatus(ctx);
}

function showGoal(ctx: ExtensionCommandContext): void {
	const goal = loadOrMigrateActiveGoal(ctx);
	ctx.ui.notify(goal ? goalViewMessage(goal) : "No active goal — use /goal set <objective>", "info");
}

function setGoalFromCommand(
	objective: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	clearRetry: (sessionId: string) => void,
): void {
	const result = setGoal({
		objective,
		ctx,
		pi,
		beforeSave: () => clearRetry(ctx.sessionManager.getSessionId()),
	});
	ctx.ui.notify(result.message, result.severity);
}

function handleGoalCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	clearRetry: (sessionId: string) => void,
): void {
	const parsedArgs = parseGoalArgs(args);
	if ("error" in parsedArgs) return ctx.ui.notify(parsedArgs.error, "error");
	switch (parsedArgs.action) {
		case "view":
			return showGoal(ctx);
		case "pause":
			return handleGoalPauseCommand(ctx, clearRetry);
		case "resume":
			return handleGoalResumeCommand(ctx, pi, clearRetry);
		case "clear":
			return handleGoalClearCommand(ctx, clearRetry);
		case "set":
			return setGoalFromCommand(parsedArgs.objective, ctx, pi, clearRetry);
	}
}

function sameRunningGoal(ctx: ExtensionContext, goal: Goal): boolean {
	const activeGoal = loadOrMigrateRunningGoal(ctx);
	return activeGoal?.createdAt === goal.createdAt && activeGoal.objective === goal.objective;
}

function appendGoalSchedulingError(pi: ExtensionAPI, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	appendSupervisorStatus(pi, `Goal wait failed: ${message}`);
}

function injectGoalContext(event: BeforeAgentStartEvent, ctx: ExtensionContext): BeforeAgentStartEventResult | undefined {
	const goal = loadOrMigrateRunningGoal(ctx);
	if (!goal) return;
	return { systemPrompt: `${event.systemPrompt}\n\n${goalSystemBlock(goal)}` };
}

function createCompletionScheduler(pi: ExtensionAPI, reviewGoal: GoalSupervisorReview) {
	return createCompletionWaitScheduler({
		pi,
		reviewGoal,
		isSameGoal: (ctx, waiting) => {
			const activeGoal = loadOrMigrateActiveGoal(ctx);
			return (
				activeGoal?.createdAt === waiting.goal.createdAt &&
				activeGoal.objective === waiting.goal.objective &&
				activeGoal.pausedAt === waiting.goal.pausedAt
			);
		},
		onComplete: (waiting, ctx) => {
			const goal = markGoalComplete(ctx, waiting.reason);
			updateGoalFooterStatus(ctx);
			if (goal) ctx.ui.notify(`Goal complete: ${goal.objective}`, "info");
		},
		onContinue: sendSupervisorInstructions.bind(undefined, pi),
		onStatus: appendSupervisorStatus.bind(undefined, pi),
		onError: appendGoalSchedulingError.bind(undefined, pi),
	});
}

type IdleGoalScheduler = GoalScheduler<Goal, GoalSupervisorResponse>;
type ApplyIdleDecision = (
	decision: GoalSupervisorResponse,
	goal: Goal,
	ctx: ExtensionContext,
	terminalTurn: AgentEndEvent["messages"],
) => Promise<void>;

interface GoalExtensionRuntime {
	emptyResponseScheduler: EmptyResponseScheduler<Goal>;
	errorStatusScheduler: ErrorStatusScheduler;
	scheduler: IdleGoalScheduler;
	completionScheduler: CompletionWaitScheduler;
	applyDecision: ApplyIdleDecision;
	clearGoalSchedules: (sessionId: string) => void;
	clearAllGoalSchedules: () => void;
}

function createIdleGoalScheduler(
	pi: ExtensionAPI,
	reviewGoal: GoalSupervisorReview,
	clearSchedules: (sessionId: string) => void,
): { scheduler: IdleGoalScheduler; applyDecision: ApplyIdleDecision } {
	let scheduler: IdleGoalScheduler;
	const applyDecision: ApplyIdleDecision = async (decision, goal, ctx, terminalTurn) => {
		clearSchedules(ctx.sessionManager.getSessionId());
		await applyGoalIdleDecision(decision, goal, ctx, pi, async () => {
			await scheduler.waitForAgentsOrScheduleReview(ctx, goal, terminalTurn);
		});
	};
	scheduler = createGoalScheduler<Goal, GoalSupervisorResponse>({
		pi,
		applyDecision,
		isSameRunningGoal: sameRunningGoal,
		reportError: appendGoalSchedulingError.bind(undefined, pi),
		reviewGoal: async (ctx, goal, terminalTurn, wakeEvidence) =>
			reviewGoal({ ctx, kind: "goal_idle_review", payload: { objective: goal.objective, terminalTurn, wakeEvidence } }),
	});
	return { scheduler, applyDecision };
}

function createGoalExtensionRuntime(pi: ExtensionAPI, reviewGoal: GoalSupervisorReview): GoalExtensionRuntime {
	const emptyResponseScheduler = createEmptyResponseScheduler<Goal>({ pi, isSameRunningGoal: sameRunningGoal });
	const errorStatusScheduler = createErrorStatusScheduler({ onStatus: appendSupervisorStatus.bind(undefined, pi) });
	let clearGoalSchedules: (sessionId: string) => void;
	const { scheduler, applyDecision } = createIdleGoalScheduler(pi, reviewGoal, (sessionId) =>
		clearGoalSchedules(sessionId),
	);
	const completionScheduler = createCompletionScheduler(pi, reviewGoal);
	clearGoalSchedules = (sessionId: string): void => {
		emptyResponseScheduler.clearSession(sessionId);
		errorStatusScheduler.clearSession(sessionId);
		scheduler.clearSession(sessionId);
		completionScheduler.clearSession(sessionId);
	};
	const clearAllGoalSchedules = (): void => {
		emptyResponseScheduler.clearAll();
		errorStatusScheduler.clearAll();
		scheduler.clearAll();
		completionScheduler.clearAll();
	};
	return {
		emptyResponseScheduler,
		errorStatusScheduler,
		scheduler,
		completionScheduler,
		applyDecision,
		clearGoalSchedules,
		clearAllGoalSchedules,
	};
}

function registerManageGoal(pi: ExtensionAPI, reviewGoal: GoalSupervisorReview, runtime: GoalExtensionRuntime): void {
	registerManageGoalTool(pi, async (params, ctx) => {
		const isCompletionReviewCurrent = runtime.completionScheduler.createReviewGuard(ctx);
		return manageGoal({
			ctx,
			params,
			pi,
			reviewGoal,
			onCompletionWait: async (goal, waitCtx, reason) => runtime.completionScheduler.wait(goal, waitCtx, reason),
			isCompletionReviewCurrent,
			beforeGoalSave: () => runtime.clearGoalSchedules(ctx.sessionManager.getSessionId()),
		});
	});
}

function registerSessionGoalHandlers(pi: ExtensionAPI, runtime: GoalExtensionRuntime): void {
	pi.on("session_start", async (event, ctx: ExtensionContext) => {
		inheritPreviousSessionGoal(event, ctx);
		const goal = loadOrMigrateActiveGoal(ctx);
		updateGoalFooterStatus(ctx);
		if (goal) ctx.ui.notify(goalStartupMessage(goal), "info");
	});
	pi.on("session_shutdown", async () => runtime.clearAllGoalSchedules());
	pi.on("input", async (_event, ctx: ExtensionContext) => {
		runtime.clearGoalSchedules(ctx.sessionManager.getSessionId());
	});
}

function registerAgentGoalHandlers(
	pi: ExtensionAPI,
	reviewGoal: GoalSupervisorReview,
	runtime: GoalExtensionRuntime,
): void {
	pi.on("agent_start", async (_event, ctx: ExtensionContext) => {
		runtime.errorStatusScheduler.clearSession(ctx.sessionManager.getSessionId());
	});
	pi.on("agent_end", async (event, ctx: ExtensionContext) => {
		await runScheduledGoalAgentEnd({
			event,
			ctx,
			reviewGoal,
			scheduler: runtime.scheduler,
			emptyResponseScheduler: runtime.emptyResponseScheduler,
			applyDecision: runtime.applyDecision,
			selectGoal: () => selectIdleGoal(event, ctx, pi, runtime),
			isSameGoal: sameRunningGoal,
		});
	});
	pi.on("before_agent_start", async (event, ctx) => {
		runtime.clearGoalSchedules(ctx.sessionManager.getSessionId());
		return injectGoalContext(event, ctx);
	});
}

function selectIdleGoal(
	event: AgentEndEvent,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	runtime: GoalExtensionRuntime,
): Goal | null {
	return selectGoalForIdleReview({
		event,
		ctx,
		selectGoal: () => loadOrMigrateRunningGoal(ctx),
		clearRetry: runtime.emptyResponseScheduler.clearSession.bind(runtime.emptyResponseScheduler),
		scheduleRetry: runtime.emptyResponseScheduler.schedule.bind(runtime.emptyResponseScheduler),
		scheduleErrorStatus: runtime.errorStatusScheduler.schedule.bind(runtime.errorStatusScheduler),
		reportSkipped: appendSupervisorStatus.bind(undefined, pi),
	});
}

function registerGoalCommand(pi: ExtensionAPI, runtime: GoalExtensionRuntime): void {
	pi.registerCommand("goal", {
		description: "Set, view, pause, resume, or clear the objective for a long-running task (/goal set <objective> | /goal | /goal pause | /goal resume | /goal clear)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			handleGoalCommand(args, ctx, pi, runtime.clearGoalSchedules);
		},
	});
}

export default function goalExtension(pi: ExtensionAPI, options: GoalExtensionOptions = {}): void {
	const reviewGoal = options.reviewGoal ?? reviewGoalWithResidentSupervisor;
	pi.registerEntryRenderer("supervisor-status", renderSupervisorStatusEntry);
	pi.registerMessageRenderer("supervisor", renderSupervisorMessage);
	const runtime = createGoalExtensionRuntime(pi, reviewGoal);
	registerManageGoal(pi, reviewGoal, runtime);
	registerSessionGoalHandlers(pi, runtime);
	registerAgentGoalHandlers(pi, reviewGoal, runtime);
	registerGoalCommand(pi, runtime);
}
