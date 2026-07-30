import type { Goal, GoalReviewEvidenceEvent } from "./goal-types.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
	const isNonNullObject = typeof value === "object" && value !== null;
	return isNonNullObject && !Array.isArray(value);
}

export function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseReviewEvidenceEvent(value: unknown): GoalReviewEvidenceEvent | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === "user" && typeof value.text === "string") {
		return { kind: "user", text: value.text };
	}
	if (value.kind === "end_turn" && typeof value.reason === "string" && value.reason.trim()) {
		return { kind: "end_turn", reason: value.reason };
	}
	return undefined;
}

function parseReviewEvidence(value: unknown): GoalReviewEvidenceEvent[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const evidence = value.flatMap((event) => {
		const parsedEvent = parseReviewEvidenceEvent(event);
		return parsedEvent ? [parsedEvent] : [];
	});
	return evidence.length > 0 ? evidence : undefined;
}

interface GoalIdentityCandidate {
	objective: string | undefined;
	branch: string | undefined;
	createdAt: string | undefined;
}

interface GoalIdentity {
	objective: string;
	branch: string;
	createdAt: string;
}

function hasGoalIdentity(candidate: GoalIdentityCandidate): candidate is GoalIdentity {
	return Boolean(candidate.objective && candidate.branch && candidate.createdAt);
}

export function parseGoal(value: unknown): Goal | null {
	if (!isRecord(value)) return null;
	const identity: GoalIdentityCandidate = {
		objective: optionalString(value.objective)?.trim(),
		branch: optionalString(value.branch),
		createdAt: optionalString(value.createdAt),
	};
	if (!hasGoalIdentity(identity)) return null;
	return {
		...identity,
		completedAt: optionalString(value.completedAt),
		completionReason: optionalString(value.completionReason),
		continuationTurns: optionalNumber(value.continuationTurns),
		pausedAt: optionalString(value.pausedAt),
		pauseReason: optionalString(value.pauseReason)?.trim() || undefined,
		reviewEvidence: parseReviewEvidence(value.reviewEvidence),
	};
}

export function parseGoalJson(value: string): Goal | null {
	try {
		return parseGoal(JSON.parse(value));
	} catch {
		return null;
	}
}
