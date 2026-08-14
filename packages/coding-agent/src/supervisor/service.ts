import {
	completeSupervisorRequest,
	hasPendingSupervisorApprovalRequest,
	readSupervisorRequest,
	requeueSupervisorRequest,
	type SupervisorRequest,
	type SupervisorRequestKind,
	type SupervisorResponse,
} from "../core/session-control-db.ts";
import { DEFAULT_SUPERVISOR_POLL_INTERVAL_MS } from "./client.ts";

export type SupervisorEvaluator = (prompt: string, signal: AbortSignal) => Promise<unknown>;

export interface RunSupervisorRequestInput {
	controlDbPath: string;
	evaluate: SupervisorEvaluator;
	request: SupervisorRequest;
	pollIntervalMs?: number;
}

function goalProgressResponseContract(): string {
	return [
		"Use kind complete, pause, wait, continue, or error with a non-empty reason.",
		"Act as a peer unblocker, not a manager: preserve agent autonomy and intervene only on evidence-backed exceptions.",
		"Treat payload.objective as the authoritative full goal; compare all progress and completion claims against its complete scope, and a completed subtask must not replace broader scope.",
		'When the agent is making competent progress or can determine its own next step, use continue with instructions exactly "Continue working toward the active goal."',
		"Use different continue instructions only when evidence identifies a concrete omission, such as unhandled pagination or a required omitted element; repeated failed or circular work; lost objective scope; or missing completion proof. Name only the exception and smallest corrective action.",
		"Do not restate the plan, prescribe routine steps, or invent oversight when evidence is uncertain.",
		"Use wait when progress is already underway asynchronously or depends on an external condition that can be rechecked, and no duplicate continuation should start.",
		"Use pause only when progress requires user action or input and cannot advance automatically.",
	].join("\n");
}

function responseContractForRequest(kind: SupervisorRequestKind): string {
	switch (kind) {
		case "approval_review":
			return "Use kind approve or reject with a non-empty reason.";
		case "goal_set_review":
			return [
				"Use kind set with a non-empty reason and objective.",
				"The returned objective must preserve every requirement and completion criterion in currentObjective, then add proposedObjective without narrowing existing scope.",
				"When currentObjective is absent, return proposedObjective unchanged.",
			].join("\n");
		case "supervisor_advisory":
			return "Use kind advisory with a non-empty answer. This response is advisory only and cannot direct or control the caller.";
		case "goal_completion_review":
		case "goal_idle_review":
			return goalProgressResponseContract();
	}
}

export function buildSupervisorPrompt(request: SupervisorRequest): string {
	const responseContract = responseContractForRequest(request.kind);
	return [
		"You are Pi Supervisor, a resident peer unblocker and policy engine.",
		"Evaluate only this bounded request, selectively reading Supervisor KB memory when necessary.",
		"Do not request or reconstruct historical session transcripts.",
		"You may read and write KB memory synchronously. Do not edit workspace files or control sessions, goals, processes, or agents.",
		`Project memory: memory/supervisor/${request.projectId}.md`,
		"Global memory: memory/supervisor/global.md",
		responseContract,
		"Call supervisor_response exactly once as the final action. Do not emit assistant text, JSON, markdown, or call end_turn before or after it.",
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

function parseGoalSetResponse(response: Record<string, unknown>): SupervisorResponse | undefined {
	if (response.kind !== "set" || typeof response.objective !== "string" || typeof response.reason !== "string") {
		return undefined;
	}
	const objective = response.objective.trim();
	return objective ? { kind: "set", objective, reason: response.reason } : undefined;
}

export function parseSupervisorResponse(
	kind: SupervisorRequestKind,
	rawResponse: unknown,
): SupervisorResponse | undefined {
	const response = parseResponseObject(rawResponse);
	if (!response || typeof response.kind !== "string") return undefined;
	if (kind === "supervisor_advisory") return parseAdvisoryResponse(response);
	if (kind === "goal_set_review") return parseGoalSetResponse(response);
	if (typeof response.reason !== "string") return undefined;
	if (response.kind === "error") return { kind: "error", reason: response.reason };
	if (kind === "approval_review") {
		return response.kind === "approve" || response.kind === "reject"
			? { kind: response.kind, reason: response.reason }
			: undefined;
	}
	if (response.kind === "complete" || response.kind === "pause" || response.kind === "wait") {
		return { kind: response.kind, reason: response.reason };
	}
	if (response.kind === "continue" && typeof response.instructions === "string" && response.instructions.trim()) {
		return { instructions: response.instructions, kind: "continue", reason: response.reason };
	}
	return undefined;
}

function parseAdvisoryResponse(response: Record<string, unknown>): SupervisorResponse | undefined {
	if (response.kind !== "advisory" || typeof response.answer !== "string") return undefined;
	return response.answer.trim() ? { answer: response.answer, kind: "advisory" } : undefined;
}

export async function runSupervisorRequest(
	input: RunSupervisorRequestInput,
): Promise<"completed" | "preempted" | "cancelled"> {
	const abortController = new AbortController();
	const evaluation = input.evaluate(buildSupervisorPrompt(input.request), abortController.signal);
	const waitResult = await waitForEvaluation(input, evaluation, abortController);
	if (waitResult === "preempted") return "preempted";
	if (waitResult === "cancelled") return "cancelled";
	if (waitResult === "expired") {
		completeSupervisorRequest(input.controlDbPath, input.request.id, requiredClaimToken(input.request), {
			kind: "error",
			reason: "Supervisor request deadline expired",
		});
		return "completed";
	}
	if (readSupervisorRequest(input.controlDbPath, input.request.id)?.status === "cancelled") return "cancelled";
	const rawResponse = await evaluation;
	if (readSupervisorRequest(input.controlDbPath, input.request.id)?.status === "cancelled") return "cancelled";
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
): Promise<"completed" | "expired" | "preempted" | "cancelled"> {
	const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_SUPERVISOR_POLL_INTERVAL_MS;
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
		if (readSupervisorRequest(input.controlDbPath, input.request.id)?.status === "cancelled") {
			abortController.abort();
			await evaluation.catch(() => undefined);
			return "cancelled";
		}
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
	return parseJsonRecord(json.trim());
}

function parseJsonRecord(json: string): Record<string, unknown> | undefined {
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
