import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
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
import { isRecord, optionalString, parseGoalJson } from "./goal-parsing.ts";
import { goalFooterStatus, goalStartupMessage, goalSystemBlock, goalViewMessage } from "./goal-presentation.ts";
import {
	createGoalReviewEvidenceController,
	type GoalReviewEvidenceController,
} from "./goal-review-evidence.ts";
import { type GoalScheduler, createGoalScheduler } from "./goal-scheduling.ts";
import {
	clearGoal,
	loadOrMigrateActiveGoal,
	loadOrMigrateGoal,
	loadOrMigrateRunningGoal,
	loadPreviousGoalFile,
	markGoalComplete,
	pauseGoal,
	resumeGoal,
	saveGoal,
} from "./goal-state.ts";
import type {
	Goal,
	GoalEvidenceReview,
	GoalExtensionOptions,
	GoalSupervisorResponse,
	GoalSupervisorReview,
	ReviewedGoalResponse,
} from "./goal-types.ts";
import { type ManageGoalParams, registerManageGoalTool } from "./goal-tool.ts";
import {
	type AppendSupervisorStatus,
	createSupervisorStatusController,
	renderSupervisorMessage,
	renderSupervisorStatusEntry,
	sendSupervisorInstructions,
	type SupervisorStatusController,
} from "./rendering.ts";
import { reviewGoalWithResidentSupervisor, withSupervisorReviewStatus } from "./supervisor-review.ts";
import { createWaitCountdownRefresher } from "./wait-countdown.ts";
import { appendGoalSchedulingError, createWaitStatusCallbacks } from "./wait-status.ts";

const MAX_OBJECTIVE_CHARS = 4000;
const USER_PAUSE_REASON = "Paused by user.";
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
	reviewGoal: GoalEvidenceReview;
	consumeReviewEvidence: (ctx: ExtensionContext, reviewedGoal: Goal, evidenceCount: number) => void;
	onCompletionWait: (goal: Goal, ctx: ExtensionContext, completionReport: string, statusReason: string) => Promise<void>;
	appendStatus: AppendSupervisorStatus;
	isCompletionReviewCurrent?: () => boolean;
	beforeGoalSave?: () => void;
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
	return previousSessionId ? loadPreviousGoalFile(ctx.cwd, previousSessionId) : null;
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
	if (params.ctx.isIdle()) params.pi.sendUserMessage("Continue working toward the active goal.");
	return {
		ok: true,
		message: "Goal set — starting work",
		severity: "info",
		goal,
	};
}

async function reviewGoalSetObjective(
	ctx: ExtensionContext,
	proposedObjective: string,
	reviewGoal: GoalEvidenceReview,
): Promise<string | AgentToolResult<unknown>> {
	const activeGoal = loadOrMigrateActiveGoal(ctx);
	const payload = activeGoal
		? { currentObjective: activeGoal.objective, proposedObjective }
		: { proposedObjective };
	const reviewed = await reviewGoal({ ctx, kind: "goal_set_review", payload });
	const currentGoal = loadOrMigrateActiveGoal(ctx);
	const reviewStillApplies = activeGoal ? goalMatchesReview(currentGoal, activeGoal) : currentGoal === null;
	if (!reviewStillApplies) return textResult("Goal changed while Supervisor review was in progress; stale decision ignored.");
	if (reviewed.decision.kind === "set") return reviewed.decision.objective;

	const reason = reviewed.decision.reason;
	ctx.ui.notify(`Supervisor goal set review failed: ${reason}`, "error");
	return textResult(`Goal not set: ${reason}`);
}

async function runSetGoalAction({
	ctx,
	params,
	pi,
	reviewGoal,
	beforeGoalSave,
}: Omit<ManageGoalContext, "consumeReviewEvidence" | "onCompletionWait" | "appendStatus">): Promise<AgentToolResult<unknown>> {
	const proposedObjective = params.objective?.trim() ?? "";
	if (!proposedObjective) return textResult("Objective is required.");
	const invalidResult = validateGoalObjective(proposedObjective);
	if (invalidResult) return textResult(invalidResult.message);

	const reviewedObjective = await reviewGoalSetObjective(ctx, proposedObjective, reviewGoal);
	if (typeof reviewedObjective !== "string") return reviewedObjective;
	const result = setGoal({ objective: reviewedObjective, ctx, pi, beforeSave: beforeGoalSave });
	ctx.ui.notify(result.message, result.severity);
	const details = result.goal ? { objective: result.goal.objective } : {};
	return textResult(result.ok ? `Goal set: ${reviewedObjective}` : result.message, details);
}

function runPauseGoalAction(
	ctx: ExtensionContext,
	reasonInput: string | undefined,
	afterGoalChange?: () => void,
): AgentToolResult<unknown> {
	if (!loadOrMigrateActiveGoal(ctx)) {
		updateGoalFooterStatus(ctx);
		ctx.ui.notify("No active goal to pause", "info");
		return textResult("No active goal to pause.");
	}
	const reason = reasonInput?.trim();
	if (!reason) {
		ctx.ui.notify("Reason is required to pause a goal", "error");
		return textResult("Reason is required to pause a goal.");
	}
	const goal = pauseGoal(ctx, reason);
	if (!goal) return textResult("No active goal to pause.");
	updateGoalFooterStatus(ctx);
	afterGoalChange?.();
	ctx.ui.notify(`Goal paused: ${reason}`, "info");
	return textResult(`Goal paused: ${reason}`, { objective: goal.objective, reason });
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
	completionReport: string,
	onWait: (goal: Goal, ctx: ExtensionContext, completionReport: string, statusReason: string) => Promise<void>,
	appendStatus: AppendSupervisorStatus,
): Promise<AgentToolResult<unknown>> {
	if (decision.kind === "complete") {
		const goal = markGoalComplete(ctx, completionReport);
		if (!goal) return textResult("No active goal to complete.");
		updateGoalFooterStatus(ctx);
		ctx.ui.notify(`Goal complete: ${goal.objective}`, "info");
		return textResult(`Goal marked complete: ${completionReport}`);
	}
	appendStatus(ctx, `Completion report rejected: ${decision.reason}\n\nSubmitted report:\n${completionReport}`);
	if (decision.kind === "continue") {
		sendSupervisorInstructions(pi, decision.instructions);
		return textResult(`Goal remains active: ${decision.reason}`, { instructions: decision.instructions });
	}
	if (decision.kind === "pause") {
		return textResult(`Goal remains active: ${decision.reason}`);
	}
	if (decision.kind === "wait") {
		await onWait(activeGoal, ctx, completionReport, decision.reason);
		return textResult(`Goal remains active: ${decision.reason}`);
	}
	ctx.ui.notify(`Supervisor goal review failed: ${decision.reason}`, "error");
	return textResult(`Goal review failed: ${decision.reason}`);
}

async function runCompleteGoalAction(
	ctx: ExtensionContext,
	completionReportInput: string | undefined,
	reviewGoal: GoalEvidenceReview,
	pi: ExtensionAPI,
	onWait: (goal: Goal, ctx: ExtensionContext, completionReport: string, statusReason: string) => Promise<void>,
	appendStatus: AppendSupervisorStatus,
	isReviewCurrent: () => boolean,
	consumeReviewEvidence: (ctx: ExtensionContext, reviewedGoal: Goal, evidenceCount: number) => void,
): Promise<AgentToolResult<unknown>> {
	const activeGoal = loadOrMigrateActiveGoal(ctx);
	if (!activeGoal) return textResult("No active goal to complete.");
	const completionReport = completionReportInput?.trim();
	if (!completionReport) return textResult("Completion report is required.");
	const reviewed = await reviewGoal({
		ctx,
		kind: "goal_completion_review",
		payload: { objective: activeGoal.objective, completionReport },
	});
	const reviewStillApplies = isReviewCurrent() && goalMatchesReview(loadOrMigrateActiveGoal(ctx), activeGoal);
	if (!reviewStillApplies) return textResult("Goal changed or review was canceled; stale decision ignored.");
	const result = await applyCompletionDecision(
		reviewed.decision,
		activeGoal,
		ctx,
		pi,
		completionReport,
		onWait,
		appendStatus,
	);
	if (reviewed.decision.kind !== "error") {
		consumeReviewEvidence(ctx, activeGoal, reviewed.evidenceCount);
	}
	return result;
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
			return runSetGoalAction({ ctx, params, pi, reviewGoal: context.reviewGoal, beforeGoalSave });
		case "pause":
			return runPauseGoalAction(ctx, params.reason, beforeGoalSave);
		case "resume":
			return runResumeGoalAction(ctx, pi, beforeGoalSave);
		case "complete":
			return runCompleteGoalAction(
				ctx,
				params.completionReport,
				context.reviewGoal,
				pi,
				context.onCompletionWait,
				context.appendStatus,
				context.isCompletionReviewCurrent ?? (() => true),
				context.consumeReviewEvidence,
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

async function applyGoalIdleDecision(
	decision: GoalSupervisorResponse,
	goal: Goal,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	onWait: (message: string) => Promise<void>,
	appendStatus: AppendSupervisorStatus,
): Promise<void> {
	switch (decision.kind) {
		case "complete":
			return completeGoalFromIdleDecision(goal, decision.reason, ctx);
		case "pause":
			return appendStatus(ctx, `Goal waiting: ${decision.reason}`);
		case "wait":
			return onWait(`Waiting: ${decision.reason}`);
		case "error":
			return onWait(`Goal review failed: ${decision.reason}`);
		case "continue":
			return continueGoalFromIdleDecision(goal, decision.instructions, ctx, pi);
		case "set":
			return appendStatus(ctx, `Goal review failed: unexpected set decision: ${decision.reason}`);
	}
}

function clearGoalRetry(ctx: ExtensionCommandContext, clearRetry: (sessionId: string) => void): void {
	clearRetry(ctx.sessionManager.getSessionId());
}

function handleGoalPauseCommand(ctx: ExtensionCommandContext, clearRetry: (sessionId: string) => void): void {
	const goal = pauseGoal(ctx, USER_PAUSE_REASON);
	if (goal) clearGoalRetry(ctx, clearRetry);
	ctx.ui.notify(goal ? `Goal paused: ${USER_PAUSE_REASON}` : "No active goal to pause", "info");
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
	if (result.ok && !ctx.isIdle()) {
		pi.sendUserMessage("Continue working toward the active goal.", { deliverAs: "followUp" });
	}
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

function injectGoalContext(event: BeforeAgentStartEvent, ctx: ExtensionContext): BeforeAgentStartEventResult | undefined {
	const goal = loadOrMigrateRunningGoal(ctx);
	if (!goal) return;
	return { systemPrompt: `${event.systemPrompt}\n\n${goalSystemBlock(goal)}` };
}

function createCompletionScheduler(
	pi: ExtensionAPI,
	reviewGoal: GoalEvidenceReview,
	evidence: GoalReviewEvidenceController,
	appendStatus: AppendSupervisorStatus,
) {
	return createCompletionWaitScheduler({
		pi,
		reviewGoal,
		consumeReviewEvidence: evidence.consume,
		isSameGoal: (ctx, waiting) => {
			const activeGoal = loadOrMigrateActiveGoal(ctx);
			return (
				activeGoal?.createdAt === waiting.goal.createdAt &&
				activeGoal.objective === waiting.goal.objective &&
				activeGoal.pausedAt === waiting.goal.pausedAt
			);
		},
		onComplete: (waiting, ctx) => {
			const goal = markGoalComplete(ctx, waiting.completionReport);
			updateGoalFooterStatus(ctx);
			if (goal) ctx.ui.notify(`Goal complete: ${goal.objective}`, "info");
		},
		onContinue: sendSupervisorInstructions.bind(undefined, pi),
		onStatus: appendStatus,
		onError: appendGoalSchedulingError.bind(undefined, appendStatus),
	});
}

type IdleGoalScheduler = GoalScheduler<Goal, ReviewedGoalResponse>;
type ApplyIdleDecision = (
	reviewed: ReviewedGoalResponse,
	goal: Goal,
	ctx: ExtensionContext,
	terminalTurn: AgentEndEvent["messages"],
) => Promise<void>;

interface GoalExtensionRuntime {
	emptyResponseScheduler: EmptyResponseScheduler<Goal>;
	errorStatusScheduler: ErrorStatusScheduler;
	scheduler: IdleGoalScheduler;
	completionScheduler: CompletionWaitScheduler;
	status: SupervisorStatusController;
	applyDecision: ApplyIdleDecision;
	clearGoalSchedules: (sessionId: string) => void;
	clearAllGoalSchedules: () => void;
}

function createIdleGoalScheduler(
	pi: ExtensionAPI,
	reviewGoal: GoalEvidenceReview,
	evidence: GoalReviewEvidenceController,
	appendStatus: AppendSupervisorStatus,
	clearSchedules: (sessionId: string) => void,
): { scheduler: IdleGoalScheduler; applyDecision: ApplyIdleDecision } {
	let scheduler: IdleGoalScheduler;
	const applyDecision: ApplyIdleDecision = async (reviewed, goal, ctx, terminalTurn) => {
		clearSchedules(ctx.sessionManager.getSessionId());
		await applyGoalIdleDecision(
			reviewed.decision,
			goal,
			ctx,
			pi,
			async (message) => {
				await scheduler.waitForAgentsOrScheduleReview(
					ctx,
					goal,
					terminalTurn,
					createWaitStatusCallbacks(appendStatus, ctx, message),
				);
			},
			appendStatus,
		);
		if (reviewed.decision.kind !== "error") evidence.consume(ctx, goal, reviewed.evidenceCount);
	};
	scheduler = createGoalScheduler<Goal, ReviewedGoalResponse>({
		pi,
		applyDecision,
		isSameRunningGoal: sameRunningGoal,
		reportError: appendGoalSchedulingError.bind(undefined, appendStatus),
		reviewGoal: async (ctx, goal, _terminalTurn, wakeEvidence) =>
			reviewGoal({ ctx, kind: "goal_idle_review", payload: { objective: goal.objective, wakeEvidence } }),
	});
	return { scheduler, applyDecision };
}

function createGoalExtensionRuntime(
	pi: ExtensionAPI,
	reviewGoal: GoalEvidenceReview,
	evidence: GoalReviewEvidenceController,
	status: SupervisorStatusController,
): GoalExtensionRuntime {
	const emptyResponseScheduler = createEmptyResponseScheduler<Goal>({ pi, isSameRunningGoal: sameRunningGoal });
	const errorStatusScheduler = createErrorStatusScheduler({ onStatus: status.append });
	let clearGoalSchedules: (sessionId: string) => void;
	const { scheduler, applyDecision } = createIdleGoalScheduler(pi, reviewGoal, evidence, status.append, (sessionId) =>
		clearGoalSchedules(sessionId),
	);
	const completionScheduler = createCompletionScheduler(pi, reviewGoal, evidence, status.append);
	clearGoalSchedules = (sessionId: string): void => {
		emptyResponseScheduler.clearSession(sessionId);
		errorStatusScheduler.clearSession(sessionId);
		scheduler.clearSession(sessionId);
		completionScheduler.clearSession(sessionId);
		status.clearSession(sessionId);
	};
	const clearAllGoalSchedules = (): void => {
		emptyResponseScheduler.clearAll();
		errorStatusScheduler.clearAll();
		scheduler.clearAll();
		completionScheduler.clearAll();
		status.clearAll();
	};
	return {
		emptyResponseScheduler,
		errorStatusScheduler,
		scheduler,
		completionScheduler,
		status,
		applyDecision,
		clearGoalSchedules,
		clearAllGoalSchedules,
	};
}

function registerManageGoal(
	pi: ExtensionAPI,
	reviewGoal: GoalEvidenceReview,
	evidence: GoalReviewEvidenceController,
	runtime: GoalExtensionRuntime,
): void {
	registerManageGoalTool(pi, async (params, ctx) => {
		const isCompletionReviewCurrent = runtime.completionScheduler.createReviewGuard(ctx);
		return manageGoal({
			ctx,
			params,
			pi,
			reviewGoal,
			consumeReviewEvidence: evidence.consume,
			onCompletionWait: async (goal, waitCtx, reason, statusReason) =>
				runtime.completionScheduler.wait(goal, waitCtx, reason, statusReason),
			appendStatus: runtime.status.append,
			isCompletionReviewCurrent,
			beforeGoalSave: () => runtime.clearGoalSchedules(ctx.sessionManager.getSessionId()),
		});
	});
}

function registerSessionGoalHandlers(
	pi: ExtensionAPI,
	evidence: GoalReviewEvidenceController,
	runtime: GoalExtensionRuntime,
): void {
	pi.on("session_start", async (event, ctx: ExtensionContext) => {
		inheritPreviousSessionGoal(event, ctx);
		const goal = loadOrMigrateActiveGoal(ctx);
		updateGoalFooterStatus(ctx);
		runtime.status.restore(ctx);
		if (goal) ctx.ui.notify(goalStartupMessage(goal), "info");
	});
	pi.on("session_shutdown", async () => runtime.clearAllGoalSchedules());
	pi.on("input", async (event, ctx: ExtensionContext) => {
		runtime.clearGoalSchedules(ctx.sessionManager.getSessionId());
		evidence.appendInput(event, ctx);
	});
	pi.on("tool_result", async (event, ctx: ExtensionContext) => {
		evidence.appendToolResult(event, ctx);
	});
}

function registerAgentGoalHandlers(
	pi: ExtensionAPI,
	reviewGoal: GoalEvidenceReview,
	runtime: GoalExtensionRuntime,
): void {
	pi.on("agent_start", async (_event, ctx: ExtensionContext) => {
		runtime.errorStatusScheduler.clearSession(ctx.sessionManager.getSessionId());
	});
	pi.on("agent_end", async (event, ctx: ExtensionContext) => {
		if (event.sessionContinuation) return;
		await runScheduledGoalAgentEnd({
			event,
			ctx,
			reviewGoal,
			scheduler: runtime.scheduler,
			emptyResponseScheduler: runtime.emptyResponseScheduler,
			applyDecision: runtime.applyDecision,
			selectGoal: () => selectIdleGoal(event, ctx, runtime),
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
	runtime: GoalExtensionRuntime,
): Goal | null {
	return selectGoalForIdleReview({
		event,
		ctx,
		selectGoal: () => loadOrMigrateRunningGoal(ctx),
		clearRetry: runtime.emptyResponseScheduler.clearSession.bind(runtime.emptyResponseScheduler),
		scheduleRetry: runtime.emptyResponseScheduler.schedule.bind(runtime.emptyResponseScheduler),
		scheduleErrorStatus: runtime.errorStatusScheduler.schedule.bind(runtime.errorStatusScheduler),
		reportSkipped: (message) => runtime.status.append(ctx, message),
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
	const status = createSupervisorStatusController(pi, createWaitCountdownRefresher());
	const supervisorReview = withSupervisorReviewStatus(
		status.append,
		options.reviewGoal ?? reviewGoalWithResidentSupervisor,
	);
	const evidence = createGoalReviewEvidenceController(
		{ loadActiveGoal: loadOrMigrateActiveGoal, saveGoal },
		supervisorReview,
	);
	pi.registerEntryRenderer("supervisor-status", renderSupervisorStatusEntry);
	pi.registerMessageRenderer("supervisor", renderSupervisorMessage);
	const runtime = createGoalExtensionRuntime(pi, evidence.review, evidence, status);
	registerManageGoal(pi, evidence.review, evidence, runtime);
	registerSessionGoalHandlers(pi, evidence, runtime);
	registerAgentGoalHandlers(pi, evidence.review, runtime);
	registerGoalCommand(pi, runtime);
}
