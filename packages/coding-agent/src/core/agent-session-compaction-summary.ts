import type { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import {
	type MaterializeCompactionSummaryResult,
	materializeCompactionSummary as materializeProviderNativeCompactionSummary,
} from "./compaction/index.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

export function updateCompactionSummary(
	sessionManager: SessionManager,
	agent: Agent,
	entryId: string,
	summary: string,
): void {
	sessionManager.updateCompactionSummary(entryId, summary);
	agent.state.messages = sessionManager.buildSessionContext().messages;
}

export function abortCompactionSummaryMaterialization(abortController: AbortController | undefined): void {
	abortController?.abort();
}

export async function materializeCompactionSummary(input: {
	entryId: string;
	sessionManager: SessionManager;
	model: Model<Api> | undefined;
	settingsManager: SettingsManager;
	streamFn: Agent["streamFn"];
	getRequiredRequestAuth: (model: Model<Api>) => Promise<{
		apiKey: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}>;
	abortController: AbortController | undefined;
	setAbortController: (controller: AbortController | undefined) => void;
}): Promise<MaterializeCompactionSummaryResult> {
	const entry = input.sessionManager.getEntry(input.entryId);
	if (!entry) throw new Error(`Entry ${input.entryId} not found`);
	if (entry.type !== "compaction") throw new Error(`Entry ${input.entryId} is not a compaction`);
	const checkpoint = entry.providerNative;
	if (!checkpoint) throw new Error(`Compaction entry ${input.entryId} has no provider-native checkpoint`);
	const model = input.model;
	if (!model) throw new Error("No model available for compaction summary materialization");
	const matchingProvider = checkpoint.provider === model.provider;
	const matchingApi = checkpoint.api === model.api;
	const supportedFormat = checkpoint.format === "openai.responses.input" && Array.isArray(checkpoint.value);
	if (!matchingProvider || !matchingApi || !supportedFormat) {
		throw new Error(
			`Compaction summary materialization requires an active ${checkpoint.provider}/${checkpoint.api} model`,
		);
	}
	if (input.abortController) {
		throw new Error("Compaction summary materialization is already running");
	}
	const abortController = new AbortController();
	input.setAbortController(abortController);
	try {
		const { apiKey, headers, env } = await input.getRequiredRequestAuth(model);
		const settings = input.settingsManager.getCompactionSettings();
		return await materializeProviderNativeCompactionSummary(entry, model, {
			apiKey,
			env,
			headers,
			reserveTokens: settings.reserveTokens,
			signal: abortController.signal,
			streamFn: input.streamFn,
			sessionId: input.sessionManager.getSessionId(),
		});
	} finally {
		input.setAbortController(undefined);
	}
}
