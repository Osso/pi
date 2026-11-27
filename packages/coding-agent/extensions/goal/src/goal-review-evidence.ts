import type {
	AskQuestionsToolDetails,
	ExtensionContext,
	InputEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeMailboxEvent } from "../../../src/core/extensions/types.ts";
import { readQueuedQuestionAnswers, readQueuedQuestionRequestId } from "../../../src/core/tools/ask-questions.ts";
import type { ActiveAgentEvidence } from "./goal-scheduling.ts";
import type {
	Goal,
	GoalEvidenceReview,
	GoalReviewEvidenceEvent,
	GoalSupervisorReview,
	ReviewedGoalResponse,
} from "./goal-types.ts";

interface GoalReviewEvidenceStore {
	loadActiveGoal(ctx: ExtensionContext): Goal | null;
	saveGoal(ctx: ExtensionContext, goal: Goal): void;
	listActiveAgents(): Promise<ActiveAgentEvidence[]>;
}

export interface GoalReviewEvidenceController {
	appendInput(event: InputEvent, ctx: ExtensionContext): void;
	appendToolResult(event: ToolResultEvent, ctx: ExtensionContext): void;
	appendMailboxMessage(event: RuntimeMailboxEvent, ctx: ExtensionContext): void;
	consume(ctx: ExtensionContext, reviewedGoal: Goal, evidenceCount: number): void;
	review: GoalEvidenceReview;
}

function appendEvidence(
	store: GoalReviewEvidenceStore,
	ctx: ExtensionContext,
	evidence: GoalReviewEvidenceEvent,
): void {
	const goal = store.loadActiveGoal(ctx);
	if (!goal) return;
	store.saveGoal(ctx, { ...goal, reviewEvidence: [...(goal.reviewEvidence ?? []), evidence] });
}

function appendInputEvidence(store: GoalReviewEvidenceStore, event: InputEvent, ctx: ExtensionContext): void {
	if (event.source === "extension" || event.text.length === 0) return;
	appendEvidence(store, ctx, { kind: "user", text: event.text });
}

function appendEndTurnEvidence(store: GoalReviewEvidenceStore, event: ToolResultEvent, ctx: ExtensionContext): void {
	if (event.toolName !== "end_turn" || event.isError) return;
	const reason = event.input.reason;
	if (typeof reason !== "string" || reason.trim().length === 0) return;
	appendEvidence(store, ctx, { kind: "end_turn", reason });
}

// Blocking ask_questions answers are user input delivered through a tool result; Supervisor answers are not.
function answeredQuestionsText(event: ToolResultEvent): string | undefined {
	if (event.toolName !== "ask_questions" || event.isError) return undefined;
	const details = event.details as AskQuestionsToolDetails | undefined;
	if (!details || details.cancelled || details.queued || details.answeredBy === "supervisor") return undefined;
	const text = event.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	return text.length > 0 ? text : undefined;
}

function consumeEvidence(
	store: GoalReviewEvidenceStore,
	ctx: ExtensionContext,
	reviewedGoal: Goal,
	evidenceCount: number,
): void {
	if (evidenceCount === 0) return;
	const goal = store.loadActiveGoal(ctx);
	const isReviewedGoal = goal?.createdAt === reviewedGoal.createdAt && goal.objective === reviewedGoal.objective;
	if (!isReviewedGoal || !goal.reviewEvidence) return;
	const remainingEvidence = goal.reviewEvidence.slice(evidenceCount);
	store.saveGoal(ctx, {
		...goal,
		reviewEvidence: remainingEvidence.length > 0 ? remainingEvidence : undefined,
	});
}

function createEvidenceReview(store: GoalReviewEvidenceStore, reviewGoal: GoalSupervisorReview): GoalEvidenceReview {
	return async (input): Promise<ReviewedGoalResponse> => {
		const conversationEvents = store.loadActiveGoal(input.ctx)?.reviewEvidence ?? [];
		const payload = conversationEvents.length > 0 ? { ...input.payload, conversationEvents } : input.payload;
		const decision = await reviewGoal({ ...input, payload });
		return { decision, evidenceCount: conversationEvents.length };
	};
}

/** Enough to cover a request and its follow-ups; older messages are dropped first. */
const MAX_USER_MESSAGES = 20;

interface OpenQuestionRequest {
	requestId: string;
	questions: string[];
}

/** A nonblocking ask_questions call that is now waiting for its answer in the session inbox. */
function queuedQuestionRequest(event: ToolResultEvent): OpenQuestionRequest | undefined {
	if (event.toolName !== "ask_questions" || event.isError) return undefined;
	const details = event.details as AskQuestionsToolDetails | undefined;
	if (!details?.queued || !details.requestId) return undefined;
	return { requestId: details.requestId, questions: details.questions.map((entry) => entry.question) };
}

/**
 * Each session's unanswered nonblocking ask_questions requests. In memory only: the question panel
 * lives in this process, so a restart closes the question as well.
 */
function createOpenQuestionTracker() {
	const open = new Map<string, OpenQuestionRequest[]>();
	return {
		add(sessionId: string, request: OpenQuestionRequest) {
			open.set(sessionId, [...(open.get(sessionId) ?? []), request]);
		},
		close(sessionId: string, requestId: string) {
			const remaining = (open.get(sessionId) ?? []).filter((request) => request.requestId !== requestId);
			if (remaining.length > 0) open.set(sessionId, remaining);
			else open.delete(sessionId);
		},
		get: (sessionId: string) => open.get(sessionId),
	};
}

/** A failed agent listing is reported to the Supervisor instead of aborting the review. */
async function readActiveAgentEvidence(store: GoalReviewEvidenceStore): Promise<Record<string, unknown>> {
	try {
		const activeAgents = await store.listActiveAgents();
		return activeAgents.length > 0 ? { activeAgents } : {};
	} catch (error) {
		return { activeAgentsError: error instanceof Error ? error.message : String(error) };
	}
}

export function createGoalReviewEvidenceController(
	store: GoalReviewEvidenceStore,
	reviewGoal: GoalSupervisorReview,
): GoalReviewEvidenceController {
	// Every genuine user message per session, oldest first: follow-ups such as "also add X" extend
	// earlier requests instead of replacing them.
	const userMessages = new Map<string, string[]>();
	const recordUserMessage = (ctx: ExtensionContext, text: string) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const messages = [...(userMessages.get(sessionId) ?? []), text];
		userMessages.set(sessionId, messages.slice(-MAX_USER_MESSAGES));
	};
	const openQuestions = createOpenQuestionTracker();
	const review = createEvidenceReview(store, reviewGoal);
	return {
		appendInput(event, ctx) {
			if (event.source !== "extension" && event.text.length > 0) recordUserMessage(ctx, event.text);
			appendInputEvidence(store, event, ctx);
		},
		appendToolResult(event, ctx) {
			appendEndTurnEvidence(store, event, ctx);
			const queued = queuedQuestionRequest(event);
			if (queued) openQuestions.add(ctx.sessionManager.getSessionId(), queued);
			const answers = answeredQuestionsText(event);
			if (!answers) return;
			recordUserMessage(ctx, answers);
			appendEvidence(store, ctx, { kind: "user", text: answers });
		},
		// Nonblocking ask_questions answers arrive through the session inbox, not as a tool result.
		appendMailboxMessage(event, ctx) {
			const sessionId = ctx.sessionManager.getSessionId();
			const requestId = readQueuedQuestionRequestId(event.message, sessionId);
			if (requestId !== undefined) openQuestions.close(sessionId, requestId);
			const answers = readQueuedQuestionAnswers(event.message, sessionId);
			if (!answers) return;
			recordUserMessage(ctx, answers);
			appendEvidence(store, ctx, { kind: "user", text: answers });
		},
		consume: consumeEvidence.bind(undefined, store),
		async review(input) {
			const sessionId = input.ctx.sessionManager.getSessionId();
			const messages = userMessages.get(sessionId);
			const open = openQuestions.get(sessionId);
			const agentEvidence = await readActiveAgentEvidence(store);
			const payload = {
				...input.payload,
				...(messages ? { userMessages: messages } : {}),
				...(open ? { openQuestions: open } : {}),
				...agentEvidence,
			};
			return review({ ...input, payload });
		},
	};
}
