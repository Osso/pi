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
import { readSessionHeader } from "../../../src/core/session-manager.ts";
import { type CompletionWaitScheduler, createGoalCompletionScheduler } from "./completion-scheduling.ts";
import { createEmptyResponseScheduler, type EmptyResponseScheduler } from "./empty-response-scheduling.ts";
import { createErrorStatusScheduler, type ErrorStatusScheduler } from "./error-status-scheduling.ts";
import { type ApplyIdleDecision, runScheduledGoalAgentEnd } from "./goal-agent-end-scheduling.ts";
import { parseGoalArgs } from "./goal-args.ts";
import { selectGoalForIdleReview } from "./goal-idle-selection.ts";
import { deduplicateCurrentGoalScope } from "./goal-objective.ts";
import { parseGoalJson } from "./goal-parsing.ts";
import { goalStartupMessage, goalSystemBlock, goalViewMessage } from "./goal-presentation.ts";
import { createGoalReviewEvidenceController, type GoalReviewEvidenceController } from "./goal-review-evidence.ts";
import { createGoalScheduler, type GoalScheduler } from "./goal-scheduling.ts";
import {
	clearGoal,
	createGoal,
	goalMatchesReview,
	loadOrMigrateActiveGoal,
	loadOrMigrateGoal,
	loadOrMigrateRunningGoal,
	loadPreviousGoalFile,
	markGoalComplete,
	pauseGoal,
	recordContinuationTurn,
	resumeGoal,
	saveGoal,
	USER_PAUSE_REASON,
} from "./goal-state.ts";
import { type ManageGoalParams, registerManageGoalTool } from "./goal-tool.ts";
import type {
	Goal,
	GoalEvidenceReview,
	GoalExtensionOptions,
	GoalSupervisorResponse,
	ReviewedGoalResponse,
} from "./goal-types.ts";
import { createGoalWorkStarter, type GoalWorkStarter } from "./goal-work.ts";
import {
	continueMission,
	MISSION_GOAL_COMPLETION_REJECTED,
	registerMissionCommand,
	restoreMissionToGoal,
	updateGoalFooterStatus,
} from "./mission.ts";
import {
	type AppendSupervisorStatus,
	createSupervisorStatusController,
	createSupervisorStatusEntryRenderer,
	renderSupervisorMessage,
	type SupervisorStatusController,
	sendSupervisorInstructions,
	supervisorInstructionContent,
} from "./rendering.ts";
import { reviewGoalWithResidentSupervisor, withSupervisorReviewStatus } from "./supervisor-review.ts";
import { createWaitCountdownRefresher } from "./wait-countdown.ts";
import { appendGoalSchedulingError, createWaitStatusCallbacks } from "./wait-status.ts";

const MAX_OBJECTIVE_CHARS = 10_000;
const RESERVED_GOAL_OBJECTIVES = new Set(["set", "pause", "resume", "clear", "status", "complete", "continue"]);

export type { Goal, GoalExtensionOptions, GoalSupervisorResponse, GoalSupervisorReview } from "./goal-types.ts";

interface SetGoalParams {
	objective: string;
	ctx: ExtensionContext;
	goalWork: GoalWorkStarter;
	beforeSave?: () => void;
}

interface ManageGoalContext {
	ctx: ExtensionContext;
	params: ManageGoalParams;
	goalWork: GoalWorkStarter;
	reviewGoal: GoalEvidenceReview;
	consumeReviewEvidence: (ctx: ExtensionContext, reviewedGoal: Goal, evidenceCount: number) => void;
	onCompletionWait: CompletionWaitScheduler["wait"];
	appendStatus: AppendSupervisorStatus;
	isCompletionReviewCurrent?: () => boolean;
	beforeGoalSave?: () => void;
}

function sessionIdFromSessionFile(sessionFile: string): string | null {
	return readSessionHeader(sessionFile)?.id ?? null;
}

function isGoalInheritanceEvent(
	event: SessionStartEvent,
): event is SessionStartEvent & { previousSessionFile: string } {
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

function setGoal(params: SetGoalParams): SetGoalResult {
	const invalidResult = validateGoalObjective(params.objective);
	if (invalidResult) return invalidResult;
	params.beforeSave?.();
	const goal = createGoal(params.objective, params.ctx.cwd);
	saveGoal(params.ctx, goal);
	updateGoalFooterStatus(params.ctx);
	params.goalWork.start(params.ctx);
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
	const payload = activeGoal ? { currentObjective: activeGoal.objective, proposedObjective } : { proposedObjective };
	const reviewed = await reviewGoal({ ctx, kind: "goal_set_review", payload });
	const currentGoal = loadOrMigrateActiveGoal(ctx);
	const reviewStillApplies = activeGoal ? goalMatchesReview(currentGoal, activeGoal) : currentGoal === null;
	if (!reviewStillApplies)
		return textResult("Goal changed while Supervisor review was in progress; stale decision ignored.");
	if (reviewed.decision.kind === "set") {
		return activeGoal
			? deduplicateCurrentGoalScope(reviewed.decision.objective, activeGoal.objective)
			: reviewed.decision.objective;
	}

	const reason = reviewed.decision.reason;
	return textResult(`Goal not set: ${reason}`);
}

async function runSetGoalAction({
	ctx,
	params,
	goalWork,
	reviewGoal,
	beforeGoalSave,
}: Omit<ManageGoalContext, "consumeReviewEvidence" | "onCompletionWait" | "appendStatus">): Promise<
	AgentToolResult<unknown>
> {
	const proposedObjective = params.objective?.trim() ?? "";
	if (!proposedObjective) return textResult("Objective is required.");
	const invalidResult = validateGoalObjective(proposedObjective);
	if (invalidResult) return textResult(invalidResult.message);

	const reviewedObjective = await reviewGoalSetObjective(ctx, proposedObjective, reviewGoal);
	if (typeof reviewedObjective !== "string") return reviewedObjective;
	const result = setGoal({ objective: reviewedObjective, ctx, goalWork, beforeSave: beforeGoalSave });
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
		return textResult("No active goal to pause.");
	}
	const reason = reasonInput?.trim();
	if (!reason) {
		return textResult("Reason is required to pause a goal.");
	}
	const goal = pauseGoal(ctx, reason);
	if (!goal) return textResult("No active goal to pause.");
	updateGoalFooterStatus(ctx);
	afterGoalChange?.();
	return textResult(`Goal paused: ${reason}`, { objective: goal.objective, reason });
}

function runResumeGoalAction(
	ctx: ExtensionContext,
	goalWork: GoalWorkStarter,
	afterGoalChange?: () => void,
): AgentToolResult<unknown> {
	const goal = resumeGoal(ctx);
	updateGoalFooterStatus(ctx);
	if (!goal) {
		return textResult("No paused goal to resume.");
	}

	afterGoalChange?.();
	goalWork.start(ctx);
	return textResult(`Goal resumed: ${goal.objective}`, { objective: goal.objective });
}

async function applyCompletionDecision(
	decision: GoalSupervisorResponse,
	activeGoal: Goal,
	ctx: ExtensionContext,
	completionReport: string,
	onWait: CompletionWaitScheduler["wait"],
	appendStatus: AppendSupervisorStatus,
): Promise<AgentToolResult<unknown>> {
	if (decision.kind === "complete") {
		const goal = markGoalComplete(ctx, completionReport);
		if (!goal) return textResult("No active goal to complete.");
		updateGoalFooterStatus(ctx);
		return textResult(`Goal marked complete: ${completionReport}`);
	}
	const rejection = `Completion report rejected: ${decision.reason}\n\nSubmitted report:\n${completionReport}`;
	appendStatus(
		ctx,
		decision.kind === "continue" ? `${rejection}\n\n${decision.instructions}` : rejection,
		undefined,
		decision.displayId,
	);
	// The run is still active: it reads the instruction now, so nothing is queued behind it.
	if (decision.kind === "continue") {
		const text = `Goal remains active: ${decision.reason}\n\n${supervisorInstructionContent(decision.instructions)}`;
		return textResult(text, { instructions: decision.instructions });
	}
	if (decision.kind === "pause") {
		return textResult(`Goal remains active: ${decision.reason}`, { completionPaused: true });
	}
	if (decision.kind === "wait") {
		await onWait(activeGoal, ctx, completionReport, decision.reason, decision.displayId);
		return textResult(`Goal remains active: ${decision.reason}`);
	}
	return textResult(`Goal review failed: ${decision.reason}`);
}

async function runCompleteGoalAction(
	ctx: ExtensionContext,
	completionReportInput: string | undefined,
	reviewGoal: GoalEvidenceReview,
	onWait: CompletionWaitScheduler["wait"],
	appendStatus: AppendSupervisorStatus,
	isReviewCurrent: () => boolean,
	consumeReviewEvidence: (ctx: ExtensionContext, reviewedGoal: Goal, evidenceCount: number) => void,
): Promise<AgentToolResult<unknown>> {
	const activeGoal = loadOrMigrateActiveGoal(ctx);
	if (!activeGoal) return textResult("No active goal to complete.");
	if (activeGoal.mission) return textResult(MISSION_GOAL_COMPLETION_REJECTED);
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
	return textResult(message);
}

function runGoalStatusAction(ctx: ExtensionContext): AgentToolResult<unknown> {
	const goal = loadOrMigrateActiveGoal(ctx);
	const message = goal ? goalViewMessage(goal) : "No active goal — use /goal set <objective>";
	const details = goal ? { objective: goal.objective } : {};
	return textResult(message, details);
}

async function manageGoal(context: ManageGoalContext): Promise<AgentToolResult<unknown>> {
	const result = await runManageGoalAction(context);
	if (context.params.action !== "status") continueMission(context.ctx, context.goalWork);
	return result;
}

async function runManageGoalAction(context: ManageGoalContext): Promise<AgentToolResult<unknown>> {
	const { ctx, params, goalWork, beforeGoalSave } = context;
	switch (params.action) {
		case "set":
			return runSetGoalAction({ ctx, params, goalWork, reviewGoal: context.reviewGoal, beforeGoalSave });
		case "pause":
			return runPauseGoalAction(ctx, params.reason, beforeGoalSave);
		case "resume":
			return runResumeGoalAction(ctx, goalWork, beforeGoalSave);
		case "complete":
			return runCompleteGoalAction(
				ctx,
				params.completionReport,
				context.reviewGoal,
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

interface IdleDecisionEffects {
	pi: ExtensionAPI;
	goalWork: GoalWorkStarter;
	onWait: (message: string) => Promise<void>;
	appendStatus: AppendSupervisorStatus;
}

/** A mission goal never completes, so it continues; any other goal completes and hands over to the mission. */
function completeGoalFromIdleDecision(
	goal: Goal,
	reason: string,
	ctx: ExtensionContext,
	goalWork: GoalWorkStarter,
): void {
	if (goal.mission) {
		recordContinuationTurn(goal, ctx);
		goalWork.start(ctx);
		return;
	}
	markGoalComplete(ctx, reason);
	ctx.ui.notify(`Goal complete: ${goal.objective}`, "info");
	continueMission(ctx, goalWork);
}

async function applyGoalIdleDecision(
	decision: GoalSupervisorResponse,
	goal: Goal,
	ctx: ExtensionContext,
	effects: IdleDecisionEffects,
): Promise<void> {
	switch (decision.kind) {
		case "complete":
			return completeGoalFromIdleDecision(goal, decision.reason, ctx, effects.goalWork);
		case "pause":
			return effects.appendStatus(ctx, `Goal waiting: ${decision.reason}`);
		case "wait":
			return effects.onWait(`Waiting: ${decision.reason}`);
		case "error":
			return effects.onWait(`Goal review failed: ${decision.reason}`);
		case "continue":
			recordContinuationTurn(goal, ctx);
			return sendSupervisorInstructions(effects.pi, decision.instructions, decision.displayId);
		case "set":
			return effects.appendStatus(ctx, `Goal review failed: unexpected set decision: ${decision.reason}`);
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
	goalWork: GoalWorkStarter,
	clearRetry: (sessionId: string) => void,
): void {
	const goal = resumeGoal(ctx);
	if (goal) clearGoalRetry(ctx, clearRetry);
	ctx.ui.notify(goal ? `Goal resumed: ${goal.objective}` : "No paused goal to resume", "info");
	updateGoalFooterStatus(ctx);
	if (goal) goalWork.start(ctx);
}

function handleGoalClearCommand(
	ctx: ExtensionCommandContext,
	goalWork: GoalWorkStarter,
	clearRetry: (sessionId: string) => void,
): void {
	const cleared = clearGoal(ctx);
	if (cleared) clearGoalRetry(ctx, clearRetry);
	ctx.ui.notify(cleared ? "Goal cleared" : "No active goal", "info");
	continueMission(ctx, goalWork);
}

function showGoal(ctx: ExtensionCommandContext): void {
	const goal = loadOrMigrateActiveGoal(ctx);
	ctx.ui.notify(goal ? goalViewMessage(goal) : "No active goal — use /goal set <objective>", "info");
}

function setGoalFromCommand(
	objective: string,
	ctx: ExtensionCommandContext,
	goalWork: GoalWorkStarter,
	clearRetry: (sessionId: string) => void,
): void {
	const result = setGoal({
		objective,
		ctx,
		goalWork,
		beforeSave: () => clearRetry(ctx.sessionManager.getSessionId()),
	});
	ctx.ui.notify(result.message, result.severity);
}

function handleGoalCommand(
	args: string,
	ctx: ExtensionCommandContext,
	goalWork: GoalWorkStarter,
	clearRetry: (sessionId: string) => void,
): void {
	const parsedArgs = parseGoalArgs(args);
	if ("error" in parsedArgs) {
		ctx.ui.notify(parsedArgs.error, "error");
		return;
	}
	switch (parsedArgs.action) {
		case "view":
			showGoal(ctx);
			break;
		case "pause":
			handleGoalPauseCommand(ctx, clearRetry);
			break;
		case "resume":
			handleGoalResumeCommand(ctx, goalWork, clearRetry);
			break;
		case "clear":
			handleGoalClearCommand(ctx, goalWork, clearRetry);
			break;
		case "set":
			setGoalFromCommand(parsedArgs.objective, ctx, goalWork, clearRetry);
			break;
	}
}

function sameRunningGoal(ctx: ExtensionContext, goal: Goal): boolean {
	const activeGoal = loadOrMigrateRunningGoal(ctx);
	return activeGoal?.createdAt === goal.createdAt && activeGoal.objective === goal.objective;
}

function injectGoalContext(
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
): BeforeAgentStartEventResult | undefined {
	const goal = loadOrMigrateRunningGoal(ctx);
	if (!goal) return;
	return { systemPrompt: `${event.systemPrompt}\n\n${goalSystemBlock(goal)}` };
}

type IdleGoalScheduler = GoalScheduler<Goal, ReviewedGoalResponse>;
interface GoalExtensionRuntime {
	emptyResponseScheduler: EmptyResponseScheduler<Goal>;
	errorStatusScheduler: ErrorStatusScheduler;
	scheduler: IdleGoalScheduler;
	completionScheduler: CompletionWaitScheduler;
	status: SupervisorStatusController;
	goalWork: GoalWorkStarter;
	applyDecision: ApplyIdleDecision;
	clearGoalSchedules: (sessionId: string) => void;
	clearAllGoalSchedules: () => void;
	/** Sessions whose completion review paused this run; its agent_end must not start an idle review. */
	completionPausedSessions: Set<string>;
}

interface IdleGoalSchedulerDeps {
	pi: ExtensionAPI;
	reviewGoal: GoalEvidenceReview;
	evidence: GoalReviewEvidenceController;
	status: SupervisorStatusController;
	goalWork: GoalWorkStarter;
}

function createIdleGoalScheduler(
	deps: IdleGoalSchedulerDeps,
	clearSchedules: (sessionId: string) => void,
): { scheduler: IdleGoalScheduler; applyDecision: ApplyIdleDecision } {
	const { pi, reviewGoal, evidence, status, goalWork } = deps;
	let scheduler: IdleGoalScheduler;
	const applyDecision: ApplyIdleDecision = async (reviewed, goal, ctx, terminalTurn) => {
		clearSchedules(ctx.sessionManager.getSessionId());
		const appendStatus: AppendSupervisorStatus = (statusCtx, message, reviewAt) =>
			status.append(statusCtx, message, reviewAt, reviewed.decision.displayId);
		const onWait = async (message: string): Promise<void> => {
			await scheduler.waitForAgentsOrScheduleReview(
				ctx,
				goal,
				terminalTurn,
				createWaitStatusCallbacks(appendStatus, ctx, message, () =>
					status.clearSession(ctx.sessionManager.getSessionId()),
				),
			);
		};
		await applyGoalIdleDecision(reviewed.decision, goal, ctx, { pi, goalWork, onWait, appendStatus });
		if (reviewed.decision.kind !== "error") evidence.consume(ctx, goal, reviewed.evidenceCount);
	};
	scheduler = createIdleReviewScheduler(pi, reviewGoal, status.append, applyDecision);
	return { scheduler, applyDecision };
}

function createIdleReviewScheduler(
	pi: ExtensionAPI,
	reviewGoal: GoalEvidenceReview,
	appendStatus: AppendSupervisorStatus,
	applyDecision: ApplyIdleDecision,
): IdleGoalScheduler {
	return createGoalScheduler<Goal, ReviewedGoalResponse>({
		pi,
		applyDecision,
		isSameRunningGoal: sameRunningGoal,
		reportError: appendGoalSchedulingError.bind(undefined, appendStatus),
		reviewGoal: async (ctx, goal, _terminalTurn, wakeEvidence) =>
			reviewGoal({ ctx, kind: "goal_idle_review", payload: { objective: goal.objective, wakeEvidence } }),
	});
}

interface ClearableSchedule {
	clearSession(sessionId: string): void;
	clearAll(): void;
}

function createGoalExtensionRuntime(
	pi: ExtensionAPI,
	reviewGoal: GoalEvidenceReview,
	evidence: GoalReviewEvidenceController,
	status: SupervisorStatusController,
): GoalExtensionRuntime {
	const goalWork = createGoalWorkStarter(pi);
	const emptyResponseScheduler = createEmptyResponseScheduler<Goal>({
		startGoalWork: goalWork.start,
		isSameRunningGoal: sameRunningGoal,
	});
	const errorStatusScheduler = createErrorStatusScheduler({ onStatus: status.append });
	const schedules: ClearableSchedule[] = [emptyResponseScheduler, errorStatusScheduler, status];
	const clearGoalSchedules = (sessionId: string): void => {
		for (const schedule of schedules) schedule.clearSession(sessionId);
	};
	const { scheduler, applyDecision } = createIdleGoalScheduler(
		{ pi, reviewGoal, evidence, status, goalWork },
		clearGoalSchedules,
	);
	const completionScheduler = createGoalCompletionScheduler(pi, reviewGoal, evidence, status, goalWork);
	schedules.push(scheduler, completionScheduler);
	const clearAllGoalSchedules = (): void => {
		for (const schedule of schedules) schedule.clearAll();
		goalWork.clearAll();
	};
	return {
		emptyResponseScheduler,
		errorStatusScheduler,
		scheduler,
		completionScheduler,
		status,
		goalWork,
		applyDecision,
		clearGoalSchedules,
		clearAllGoalSchedules,
		completionPausedSessions: new Set(),
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
		const result = await manageGoal({
			ctx,
			params,
			goalWork: runtime.goalWork,
			reviewGoal,
			consumeReviewEvidence: evidence.consume,
			onCompletionWait: async (goal, waitCtx, reason, statusReason, displayId) =>
				runtime.completionScheduler.wait(goal, waitCtx, reason, statusReason, displayId),
			appendStatus: runtime.status.append,
			isCompletionReviewCurrent,
			beforeGoalSave: () => runtime.clearGoalSchedules(ctx.sessionManager.getSessionId()),
		});
		const details = result.details as { completionPaused?: boolean } | undefined;
		if (details?.completionPaused) runtime.completionPausedSessions.add(ctx.sessionManager.getSessionId());
		return result;
	});
}

function registerSessionGoalHandlers(
	pi: ExtensionAPI,
	evidence: GoalReviewEvidenceController,
	runtime: GoalExtensionRuntime,
): void {
	pi.on("session_start", async (event, ctx: ExtensionContext) => {
		inheritPreviousSessionGoal(event, ctx);
		await restoreMissionToGoal(ctx);
		const goal = loadOrMigrateActiveGoal(ctx);
		updateGoalFooterStatus(ctx);
		runtime.status.restore(ctx);
		if (goal && !goal.pausedAt) pi.requestResumeContinuation();
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
	// Observes only; delivery continues.
	pi.on("runtime_mailbox", async (event, ctx: ExtensionContext) => {
		evidence.appendMailboxMessage(event, ctx);
		return { handled: false };
	});
}

function registerAgentGoalHandlers(
	pi: ExtensionAPI,
	reviewGoal: GoalEvidenceReview,
	runtime: GoalExtensionRuntime,
): void {
	pi.on("agent_start", async (_event, ctx: ExtensionContext) => {
		runtime.errorStatusScheduler.clearSession(ctx.sessionManager.getSessionId());
		runtime.goalWork.runStarted(ctx);
	});
	pi.on("agent_end", async (event, ctx: ExtensionContext) => {
		if (event.sessionContinuation) return;
		// A completion pause leaves the goal active without scheduling another turn.
		if (runtime.completionPausedSessions.delete(ctx.sessionManager.getSessionId())) return;
		// A completion wait already owns the next review; an idle review would replace it and drop the report.
		if (runtime.completionScheduler.isWaiting(ctx.sessionManager.getSessionId())) return;
		await runtime.goalWork.runEnding(ctx, () =>
			runScheduledGoalAgentEnd({
				event,
				ctx,
				reviewGoal,
				scheduler: runtime.scheduler,
				emptyResponseScheduler: runtime.emptyResponseScheduler,
				applyDecision: runtime.applyDecision,
				selectGoal: () => selectIdleGoal(event, ctx, runtime),
				isSameGoal: sameRunningGoal,
			}),
		);
	});
	pi.on("before_agent_start", async (event, ctx) => {
		runtime.completionPausedSessions.delete(ctx.sessionManager.getSessionId());
		runtime.clearGoalSchedules(ctx.sessionManager.getSessionId());
		return injectGoalContext(event, ctx);
	});
}

function selectIdleGoal(event: AgentEndEvent, ctx: ExtensionContext, runtime: GoalExtensionRuntime): Goal | null {
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
		description:
			"Set, view, pause, resume, or clear the objective for a long-running task (/goal set <objective> | /goal | /goal pause | /goal resume | /goal clear)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			handleGoalCommand(args, ctx, runtime.goalWork, runtime.clearGoalSchedules);
		},
	});
}

export default function goalExtension(pi: ExtensionAPI, options: GoalExtensionOptions = {}): void {
	const countdownRefresher = createWaitCountdownRefresher();
	const status = createSupervisorStatusController(pi, countdownRefresher);
	const supervisorReview = withSupervisorReviewStatus(
		status.append,
		options.reviewGoal ?? reviewGoalWithResidentSupervisor,
	);
	const evidence = createGoalReviewEvidenceController(
		{ loadActiveGoal: loadOrMigrateActiveGoal, saveGoal },
		supervisorReview,
	);
	pi.registerEntryRenderer("supervisor-status", createSupervisorStatusEntryRenderer(countdownRefresher));
	pi.registerMessageRenderer("supervisor", renderSupervisorMessage);
	const runtime = createGoalExtensionRuntime(pi, evidence.review, evidence, status);
	registerManageGoal(pi, evidence.review, evidence, runtime);
	registerSessionGoalHandlers(pi, evidence, runtime);
	registerAgentGoalHandlers(pi, evidence.review, runtime);
	registerGoalCommand(pi, runtime);
	registerMissionCommand(pi, runtime.clearGoalSchedules, runtime.goalWork);
}
