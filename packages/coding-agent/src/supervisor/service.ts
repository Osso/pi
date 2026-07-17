import {
	completeSupervisorRequest,
	hasPendingSupervisorApprovalRequest,
	requeueSupervisorRequest,
	type SupervisorRequest,
	type SupervisorRequestKind,
	type SupervisorResponse,
} from "../core/session-control-db.ts";

export type SupervisorEvaluator = (prompt: string, signal: AbortSignal) => Promise<unknown>;

export interface RunSupervisorRequestInput {
	controlDbPath: string;
	evaluate: SupervisorEvaluator;
	request: SupervisorRequest;
	pollIntervalMs?: number;
}

export function buildSupervisorPrompt(request: SupervisorRequest): string {
	const responseContract =
		request.kind === "approval_review"
			? 'Return {"kind":"approve|reject","reason":"..."}.'
			: 'Return {"kind":"complete","reason":"..."} or {"kind":"continue","reason":"...","instructions":"..."}.';
	return [
		"You are Pi Supervisor, a resident local policy engine.",
		"Evaluate only this bounded request, selectively reading Supervisor KB memory when necessary.",
		"Do not request or reconstruct historical session transcripts.",
		"You may read and write KB memory synchronously. Do not edit workspace files or control sessions, goals, processes, or agents.",
		`Project memory: memory/supervisor/${request.projectId}.md`,
		"Global memory: memory/supervisor/global.md",
		responseContract,
		"Respond with exactly one JSON object and no markdown.",
		"Request:",
		JSON.stringify(
			{
				deadlineAt: request.deadlineAt,
				kind: request.kind,
				payload: request.payload,
				projectId: request.projectId,
				senderSessionId: request.senderSessionId,
			},
			null,
			2,
		),
	].join("\n");
}

export function parseSupervisorResponse(
	kind: SupervisorRequestKind,
	rawResponse: unknown,
): SupervisorResponse | undefined {
	const response = parseResponseObject(rawResponse);
	if (!response || typeof response.kind !== "string" || typeof response.reason !== "string") return undefined;

	if (response.kind === "error") return { kind: "error", reason: response.reason };
	if (kind === "approval_review") {
		return response.kind === "approve" || response.kind === "reject"
			? { kind: response.kind, reason: response.reason }
			: undefined;
	}
	if (response.kind === "complete") return { kind: "complete", reason: response.reason };
	if (response.kind === "continue" && typeof response.instructions === "string" && response.instructions.trim()) {
		return { instructions: response.instructions, kind: "continue", reason: response.reason };
	}
	return undefined;
}

export async function runSupervisorRequest(input: RunSupervisorRequestInput): Promise<"completed" | "preempted"> {
	const abortController = new AbortController();
	const evaluation = input.evaluate(buildSupervisorPrompt(input.request), abortController.signal);
	const waitResult = await waitForEvaluation(input, evaluation, abortController);
	if (waitResult === "preempted") return "preempted";
	if (waitResult === "expired") {
		completeSupervisorRequest(input.controlDbPath, input.request.id, requiredClaimToken(input.request), {
			kind: "error",
			reason: "Supervisor request deadline expired",
		});
		return "completed";
	}
	const rawResponse = await evaluation;
	const response = parseSupervisorResponse(input.request.kind, rawResponse) ?? {
		kind: "error" as const,
		reason: "Supervisor returned an invalid response",
	};
	completeSupervisorRequest(input.controlDbPath, input.request.id, requiredClaimToken(input.request), response);
	return "completed";
}

async function waitForEvaluation(
	input: RunSupervisorRequestInput,
	evaluation: Promise<unknown>,
	abortController: AbortController,
): Promise<"completed" | "expired" | "preempted"> {
	const pollIntervalMs = input.pollIntervalMs ?? 50;
	let evaluationSettled = false;
	void evaluation.then(
		() => {
			evaluationSettled = true;
		},
		() => {
			evaluationSettled = true;
		},
	);
	while (!evaluationSettled) {
		await delay(Math.min(pollIntervalMs, remainingMilliseconds(input.request.deadlineAt)));
		if (Date.now() >= Date.parse(input.request.deadlineAt)) {
			abortController.abort();
			await evaluation.catch(() => undefined);
			return "expired";
		}
		if (input.request.kind === "approval_review" || !hasPendingSupervisorApprovalRequest(input.controlDbPath)) {
			continue;
		}
		abortController.abort();
		await evaluation.catch(() => undefined);
		requeueSupervisorRequest(input.controlDbPath, input.request.id, requiredClaimToken(input.request));
		return "preempted";
	}
	return "completed";
}

function remainingMilliseconds(deadlineAt: string): number {
	return Math.max(1, Date.parse(deadlineAt) - Date.now());
}

function requiredClaimToken(request: SupervisorRequest): string {
	if (!request.claimToken) throw new Error(`Supervisor request ${request.id} has no claim token`);
	return request.claimToken;
}

function parseResponseObject(rawResponse: unknown): Record<string, unknown> | undefined {
	if (typeof rawResponse === "string") return parseJsonObject(rawResponse);
	if (!isRecord(rawResponse)) return undefined;
	const text = extractTextContent(rawResponse);
	return text ? parseJsonObject(text) : rawResponse;
}

function extractTextContent(response: Record<string, unknown>): string | undefined {
	if (!Array.isArray(response.content)) return undefined;
	const textPart = response.content.find(
		(item) => isRecord(item) && item.type === "text" && typeof item.text === "string",
	);
	return isRecord(textPart) && typeof textPart.text === "string" ? textPart.text : undefined;
}

function parseJsonObject(json: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(json);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
