import type { ExtensionContext, InputEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
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
	return {
		appendInput: appendInputEvidence.bind(undefined, store),
		appendToolResult: appendEndTurnEvidence.bind(undefined, store),
		consume: consumeEvidence.bind(undefined, store),
		review: createEvidenceReview(store, reviewGoal),
	};
}
