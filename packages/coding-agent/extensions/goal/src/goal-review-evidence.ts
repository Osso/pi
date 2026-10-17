import type {
	AskQuestionsToolDetails,
	ExtensionContext,
	InputEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
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
}

export interface GoalReviewEvidenceController {
	appendInput(event: InputEvent, ctx: ExtensionContext): void;
	appendToolResult(event: ToolResultEvent, ctx: ExtensionContext): void;
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

function appendEndTurnEvidence(
	store: GoalReviewEvidenceStore,
	event: ToolResultEvent,
	ctx: ExtensionContext,
): void {
	if (event.toolName !== "end_turn" || event.isError) return;
	const reason = event.input.reason;
	if (typeof reason !== "string" || reason.trim().length === 0) return;
	appendEvidence(store, ctx, { kind: "end_turn", reason });
}

// Blocking ask_questions answers are user input delivered through a tool result.
function answeredQuestionsText(event: ToolResultEvent): string | undefined {
	if (event.toolName !== "ask_questions" || event.isError) return undefined;
	const details = event.details as AskQuestionsToolDetails | undefined;
	if (!details || details.cancelled || details.queued) return undefined;
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
		const payload =
			conversationEvents.length > 0 ? { ...input.payload, conversationEvents } : input.payload;
		const decision = await reviewGoal({ ...input, payload });
		return { decision, evidenceCount: conversationEvents.length };
	};
}

export function createGoalReviewEvidenceController(
	store: GoalReviewEvidenceStore,
	reviewGoal: GoalSupervisorReview,
): GoalReviewEvidenceController {
	const userRequests = new Map<string, string>();
	const userAnswers = new Map<string, string[]>();
	const review = createEvidenceReview(store, reviewGoal);
	return {
		appendInput(event, ctx) {
			if (event.source !== "extension" && event.text.length > 0) {
				const sessionId = ctx.sessionManager.getSessionId();
				userRequests.set(sessionId, event.text);
				userAnswers.delete(sessionId);
			}
			appendInputEvidence(store, event, ctx);
		},
		appendToolResult(event, ctx) {
			appendEndTurnEvidence(store, event, ctx);
			const answers = answeredQuestionsText(event);
			if (!answers) return;
			const sessionId = ctx.sessionManager.getSessionId();
			userAnswers.set(sessionId, [...(userAnswers.get(sessionId) ?? []), answers]);
			appendEvidence(store, ctx, { kind: "user", text: answers });
		},
		consume: consumeEvidence.bind(undefined, store),
		review(input) {
			const sessionId = input.ctx.sessionManager.getSessionId();
			const userRequest = userRequests.get(sessionId);
			const answers = userAnswers.get(sessionId);
			return review({
				...input,
				payload: {
					...input.payload,
					...(userRequest ? { userRequest } : {}),
					...(answers ? { userAnswers: answers } : {}),
				},
			});
		},
	};
}
