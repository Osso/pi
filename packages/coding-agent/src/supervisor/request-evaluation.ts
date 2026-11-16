import { type Api, type AssistantMessage, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import { CODEX_FALLBACK_PROVIDERS, isQuotaExhaustionError } from "../core/codex-quota-fallback.ts";
import type { ModelRegistry } from "../core/model-registry.ts";
import { mergeProviderAttributionHeaders } from "../core/provider-attribution.ts";
import {
	completeSupervisorRequest,
	readSupervisorRequest,
	type SupervisorRequest,
} from "../core/session-control-db.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { sendSupervisorReply } from "./mail.ts";
import {
	buildSupervisorInstructionReviewContext,
	parseSupervisorInstructionReviewDecision,
	parseSupervisorResponse,
	runSupervisorRequest,
	SUPERVISOR_INSTRUCTION_REJECTION_REASONS,
	type SupervisorEvaluator,
	type SupervisorInstructionRejectionReason,
	type SupervisorInstructionReviewDecision,
	supervisorInstructionRejectionFeedback,
} from "./service.ts";

export const GENERIC_GOAL_CONTINUATION = "Continue working toward the active goal.";

export type SupervisorInstructionReviewer = (
	instructions: string,
	signal: AbortSignal,
) => Promise<SupervisorInstructionReviewDecision | undefined>;

export type SupervisorInstructionEvaluator = (instructions: string, signal: AbortSignal) => Promise<unknown>;

/** Session that receives instruction-veto policy feedback. */
type SupervisorFeedbackTarget = {
	sendCustomMessage?<T = unknown>(message: {
		customType: string;
		content: string;
		display: boolean;
		details?: T;
	}): Promise<void>;
};

/** Retry, timeout, and attribution settings for the stateless instruction review. */
function createInstructionReviewSettingsManager(): SettingsManager {
	return SettingsManager.inMemory({
		approvalPolicy: "auto-approve",
		approvalPreset: "auto-approve",
		sandboxProfile: "full-access",
	});
}

const SUPERVISOR_MODEL_ID = "gpt-6.1-sol";
const SUPERVISOR_PROVIDERS = ["openai-codex", ...(CODEX_FALLBACK_PROVIDERS.get("openai-codex") ?? [])];

function readConfiguredSupervisorModel(agentDir: string): string | undefined {
	return SettingsManager.create(agentDir, agentDir).getSupervisorModel();
}

function requireSupervisorModels(modelRegistry: ModelRegistry, agentDir: string): Model<Api>[] {
	const configured = readConfiguredSupervisorModel(agentDir);
	if (configured) return [requireConfiguredSupervisorModel(modelRegistry, configured)];
	const models = SUPERVISOR_PROVIDERS.flatMap((provider) => {
		const model = modelRegistry.find(provider, SUPERVISOR_MODEL_ID);
		return model && modelRegistry.hasConfiguredAuth(model) ? [model] : [];
	});
	if (models.length === 0) {
		throw new Error(
			`Pi Supervisor requires ${SUPERVISOR_MODEL_ID} on an authenticated provider: ${SUPERVISOR_PROVIDERS.join(", ")}`,
		);
	}
	return models;
}

function requireConfiguredSupervisorModel(modelRegistry: ModelRegistry, configured: string): Model<Api> {
	const slash = configured.indexOf("/");
	const model = slash > 0 ? modelRegistry.find(configured.slice(0, slash), configured.slice(slash + 1)) : undefined;
	if (!model || !modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(`Pi Supervisor supervisorModel "${configured}" is not an authenticated provider/modelId`);
	}
	return model;
}

function readSupervisorInstructionReviewText(message: AssistantMessage): string | undefined {
	if (message.stopReason !== "stop") return undefined;
	const text = message.content
		.filter((part): part is { text: string; type: "text" } => part.type === "text")
		.map((part) => part.text)
		.join("");
	return text || undefined;
}

export function createSupervisorInstructionEvaluator(
	modelRegistry: ModelRegistry,
	agentDir: string,
	cwd: string,
): SupervisorInstructionEvaluator {
	const models = requireSupervisorModels(modelRegistry, agentDir);
	const settingsManager = createInstructionReviewSettingsManager();
	const evaluateWith = async (model: Model<Api>, instructions: string, signal: AbortSignal) => {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		const retrySettings = settingsManager.getProviderRetrySettings();
		const configuredIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
		const effectiveIdleTimeoutMs = configuredIdleTimeoutMs === 0 ? 2_147_483_647 : configuredIdleTimeoutMs;
		return streamSimple(model, buildSupervisorInstructionReviewContext(instructions, Date.now()), {
			apiKey: auth.apiKey,
			cwd,
			env: auth.env,
			headers: mergeProviderAttributionHeaders(model, settingsManager, undefined, auth.headers),
			maxRetries: retrySettings.maxRetries,
			maxRetryDelayMs: retrySettings.maxRetryDelayMs,
			reasoning: "low",
			// Each review is a stateless one-off; session-backed providers such as claude-bridge route it to their one-off path.
			cacheRetention: "none",
			signal,
			timeoutMs: retrySettings.timeoutMs ?? effectiveIdleTimeoutMs,
			websocketConnectTimeoutMs: settingsManager.getWebSocketConnectTimeoutMs(),
		}).result();
	};
	return async (instructions, signal) => {
		for (const model of models) {
			if (signal.aborted) return undefined;
			const response = await evaluateWith(model, instructions, signal);
			if (signal.aborted) return undefined;
			if (!isQuotaExhaustionError(response)) return readSupervisorInstructionReviewText(response);
		}
		return undefined;
	};
}

export function createSupervisorInstructionReviewer(
	evaluate: SupervisorInstructionEvaluator,
): SupervisorInstructionReviewer {
	return async (instructions, signal) => {
		if (signal.aborted) return undefined;
		return parseSupervisorInstructionReviewDecision(await evaluate(instructions, signal));
	};
}

function isInstructionRejectionReason(value: unknown): value is SupervisorInstructionRejectionReason {
	return SUPERVISOR_INSTRUCTION_REJECTION_REASONS.some((reason) => reason === value);
}

async function appendSupervisorPolicyFeedback<T>(
	session: SupervisorFeedbackTarget,
	content: string,
	details: T,
): Promise<void> {
	await session.sendCustomMessage?.({
		customType: "supervisor_policy_feedback",
		content,
		display: false,
		details,
	});
}

async function appendSupervisorInstructionReviewFailure(
	session: SupervisorFeedbackTarget,
	failure: "evaluation_error" | "invalid_response",
): Promise<void> {
	await appendSupervisorPolicyFeedback(
		session,
		`Policy gate failure: ${failure}. Non-generic instructions were suppressed.`,
		{ failure },
	);
}

export async function applySupervisorInstructionVeto(
	request: SupervisorRequest,
	rawResponse: unknown,
	session: SupervisorFeedbackTarget,
	reviewInstructions: SupervisorInstructionReviewer,
	signal: AbortSignal,
): Promise<unknown> {
	if (request.kind !== "goal_idle_review" && request.kind !== "goal_completion_review") return rawResponse;
	const response = parseSupervisorResponse(request.kind, rawResponse);
	if (response?.kind !== "continue" || response.instructions === GENERIC_GOAL_CONTINUATION) return rawResponse;

	let decision: SupervisorInstructionReviewDecision | undefined;
	try {
		decision = await reviewInstructions(response.instructions, signal);
	} catch (error) {
		if (signal.aborted) throw error;
		await appendSupervisorInstructionReviewFailure(session, "evaluation_error");
		return { ...response, instructions: GENERIC_GOAL_CONTINUATION };
	}
	if (signal.aborted) throw new Error("Supervisor instruction review aborted");
	if (decision === "accept") return response;
	if (isInstructionRejectionReason(decision)) {
		await appendSupervisorPolicyFeedback(session, supervisorInstructionRejectionFeedback(decision), {
			reason: decision,
		});
	} else {
		await appendSupervisorInstructionReviewFailure(session, "invalid_response");
	}
	return { ...response, instructions: GENERIC_GOAL_CONTINUATION };
}

/**
 * Runs one claimed request through `evaluate`, records its typed response (an error response on failure),
 * and replies to the asking runtime. Preempted and cancelled requests get no reply.
 */
export async function evaluateAndCompleteSupervisorRequest(
	controlDbPath: string,
	request: SupervisorRequest,
	evaluate: SupervisorEvaluator,
	supervisorSessionId: string,
): Promise<void> {
	await recordSupervisorRequestOutcome(controlDbPath, request, evaluate);
	const completed = readSupervisorRequest(controlDbPath, request.id);
	if (completed?.status !== "completed" || !completed.response || !completed.replyTo) return;
	sendSupervisorReply(controlDbPath, supervisorSessionId, completed.replyTo, {
		requestKind: completed.kind,
		response: completed.response,
	});
}

async function recordSupervisorRequestOutcome(
	controlDbPath: string,
	request: SupervisorRequest,
	evaluate: SupervisorEvaluator,
): Promise<void> {
	try {
		await runSupervisorRequest({ controlDbPath, evaluate, request });
	} catch (error) {
		if (readSupervisorRequest(controlDbPath, request.id)?.status === "cancelled") return;
		try {
			completeSupervisorRequest(controlDbPath, request.id, requiredClaimToken(request), {
				kind: "error",
				reason: error instanceof Error ? error.message : String(error),
			});
		} catch (completionError) {
			if (readSupervisorRequest(controlDbPath, request.id)?.status === "cancelled") return;
			throw completionError;
		}
	}
}

function requiredClaimToken(request: SupervisorRequest): string {
	if (!request.claimToken) throw new Error(`Supervisor request ${request.id} has no claim token`);
	return request.claimToken;
}
