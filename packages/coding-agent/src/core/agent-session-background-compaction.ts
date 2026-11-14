import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import {
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	compact,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import type { ExtensionRunner } from "./extensions/index.ts";
import { computeIdleCompactionDueAt } from "./idle-compaction.ts";
import type { CompactionEntry, SessionEntry } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

export const BACKGROUND_COMPACTION_CONTEXT_RATIO = 0.7;

export interface BackgroundCompactionCache {
	state: "pending" | "ready" | "failed";
	sessionId: string;
	snapshotLeafId: string;
	branchEntries: SessionEntry[];
	preparation: CompactionPreparation;
	settings: { enabled: boolean; reserveTokens: number; keepRecentMessages: number };
	model: { provider: string; id: string; api: string };
	thinkingLevel: ThinkingLevel;
	systemPrompt: string;
	extensionRunner: ExtensionRunner;
	abortController: AbortController;
	promise?: Promise<void>;
	compaction?: CompactionResult;
	fromExtension?: boolean;
	generationDurationMs?: number;
}

interface BackgroundCompactionDependencies {
	getAgentStreamFn: () => Parameters<typeof compact>[7];
	settingsManager: SettingsManager;
	getModel: () => Model<Api> | undefined;
	getThinkingLevel: () => ThinkingLevel;
	getSystemPrompt: () => string;
	getExtensionRunner: () => ExtensionRunner;
	getBranch: () => SessionEntry[];
	getSessionId: () => string;
	getLeafId: () => string | undefined;
	getModelRegistry: () => {
		isMessageFromModel(message: Pick<AssistantMessage, "provider" | "model">, model: Model<Api>): boolean;
	};
	getCompactionAuth: (model: Model<Api>) => Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}>;
	getCooldownUntil: () => number;
	isAutoCompacting: () => boolean;
	isCompacting: () => boolean;
	isDisposed: () => boolean;
	isObserver: () => boolean;
	findLastAssistantMessage: () => AssistantMessage | undefined;
	getLatestCompactionEntry: (entries: SessionEntry[]) => CompactionEntry | null;
	assistantMessagePrecedesCompaction: (
		entries: SessionEntry[],
		message: AssistantMessage,
		entry: CompactionEntry | null,
	) => boolean;
	withTurnStartLock: (callback: () => Promise<void>) => Promise<void>;
	getIsStreaming: () => boolean;
	getLastAssistantMessage: () => AssistantMessage | undefined;
	runAutoCompaction: (reason: "threshold" | "idle", willRetry: boolean) => Promise<boolean>;
	hasPendingMessages: () => boolean;
	hasQueuedMessages: () => boolean;
	isSessionCompacting: () => boolean;
	recordCompactionFailure: (message: string) => void;
}

export class BackgroundCompactionState {
	private cache: BackgroundCompactionCache | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;

	private readonly dependencies: BackgroundCompactionDependencies;

	constructor(dependencies: BackgroundCompactionDependencies) {
		this.dependencies = dependencies;
	}

	abort(): void {
		this.cache?.abortController.abort();
	}

	clearIdleTimer(): void {
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private backgroundCompactionMatchesCurrentSession(cache: BackgroundCompactionCache): boolean {
		const model = this.dependencies.getModel();
		if (!model) return false;
		const settings = this.dependencies.settingsManager.getCompactionSettings();
		const snapshotIsAncestor = this.dependencies.getBranch().some((entry) => entry.id === cache.snapshotLeafId);
		return (
			cache.sessionId === this.dependencies.getSessionId() &&
			snapshotIsAncestor &&
			cache.model.provider === model.provider &&
			cache.model.id === model.id &&
			cache.model.api === model.api &&
			cache.thinkingLevel === this.dependencies.getThinkingLevel() &&
			cache.systemPrompt === this.dependencies.getSystemPrompt() &&
			cache.extensionRunner === this.dependencies.getExtensionRunner() &&
			cache.settings.enabled === settings.enabled &&
			cache.settings.reserveTokens === settings.reserveTokens &&
			cache.settings.keepRecentMessages === settings.keepRecentMessages
		);
	}

	hasReady(): boolean {
		const cache = this.cache;
		if (!cache || cache.state !== "ready") return false;
		if (this.backgroundCompactionMatchesCurrentSession(cache)) return true;
		this.cache = undefined;
		return false;
	}

	async cancel(): Promise<void> {
		const cache = this.cache;
		if (!cache) return;
		cache.abortController.abort();
		await cache.promise;
		if (this.cache === cache) this.cache = undefined;
	}

	async take(): Promise<BackgroundCompactionCache | undefined> {
		const cache = this.cache;
		if (!cache) return undefined;
		if (cache.state === "pending") {
			await this.cancel();
			return undefined;
		}
		this.cache = undefined;
		if (cache.state !== "ready" || !this.backgroundCompactionMatchesCurrentSession(cache)) return undefined;
		return cache;
	}

	private scheduleInstall(cache: BackgroundCompactionCache): void {
		void this.dependencies
			.withTurnStartLock(async () => {
				if (!this.backgroundCompactionMatchesCurrentSession(cache)) {
					if (this.cache === cache) this.cache = undefined;
					return;
				}
				const agentRunNeedsPostProcessing =
					this.dependencies.getIsStreaming() || this.dependencies.getLastAssistantMessage() !== undefined;
				if (this.cache !== cache || cache.state !== "ready" || agentRunNeedsPostProcessing) {
					return;
				}
				await this.dependencies.runAutoCompaction("threshold", false);
			})
			.catch((error: unknown) => {
				console.error("Failed to install background compaction cache:", error);
			});
	}

	private async generateLocal(
		cache: BackgroundCompactionCache,
		model: Model<Api>,
	): Promise<CompactionResult | undefined> {
		if (!cache.settings.enabled) return undefined;
		const { apiKey, headers, env } = await this.dependencies.getCompactionAuth(model);
		return compact(
			cache.preparation,
			model,
			apiKey,
			headers,
			undefined,
			cache.abortController.signal,
			cache.thinkingLevel,
			this.dependencies.getAgentStreamFn(),
			env,
			this.dependencies.getSessionId(),
		);
	}

	private storeReady(
		cache: BackgroundCompactionCache,
		compaction: CompactionResult,
		fromExtension: boolean,
		startedAt: number,
	): void {
		if (cache.abortController.signal.aborted || this.cache !== cache) return;
		cache.compaction = compaction;
		cache.fromExtension = fromExtension;
		cache.generationDurationMs = Date.now() - startedAt;
		cache.state = "ready";
		this.scheduleInstall(cache);
	}

	private async generate(cache: BackgroundCompactionCache, model: Model<Api>): Promise<void> {
		try {
			await cache.extensionRunner.emit({ type: "background_compaction_start" });
			const startedAt = Date.now();
			const extensionResult = cache.extensionRunner.hasHandlers("compaction")
				? await cache.extensionRunner.emit({
						type: "compaction",
						preparation: cache.preparation,
						branchEntries: cache.branchEntries,
						customInstructions: undefined,
						reason: "threshold",
						willRetry: false,
						signal: cache.abortController.signal,
					})
				: undefined;
			if (extensionResult?.cancel) return;
			const extensionCompaction = extensionResult?.compaction;
			const compaction = extensionCompaction ?? (await this.generateLocal(cache, model));
			if (!compaction) return;
			this.storeReady(cache, compaction, extensionCompaction !== undefined, startedAt);
		} catch (error) {
			if (cache.abortController.signal.aborted) return;
			cache.state = "failed";
			this.dependencies.recordCompactionFailure(error instanceof Error ? error.message : String(error));
			console.error(
				`Background compaction cache generation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			await cache.extensionRunner.emit({ type: "background_compaction_end" });
		}
	}

	startDuringToolTurn(message: AssistantMessage): void {
		if (message.stopReason !== "toolUse") return;
		const model = this.dependencies.getModel();
		if (!model || !this.dependencies.getModelRegistry().isMessageFromModel(message, model)) return;
		const contextWindow = model.contextWindow;
		const contextTokens = message.usage ? calculateContextTokens(message.usage) : 0;
		if (contextTokens <= 0 || contextWindow <= 0) return;
		const settings = this.dependencies.settingsManager.getCompactionSettings();
		const thresholdReached = shouldCompact(
			contextTokens,
			contextWindow,
			{ ...settings, enabled: true },
			model.autoCompactionThreshold,
		);
		if (thresholdReached) return;
		this.start(contextTokens, contextWindow);
	}

	start(contextTokens: number, contextWindow: number): void {
		if (Date.now() < this.dependencies.getCooldownUntil()) return;
		if (contextWindow <= 0 || contextTokens < contextWindow * BACKGROUND_COMPACTION_CONTEXT_RATIO) return;
		if (this.cache || this.dependencies.isAutoCompacting() || this.dependencies.isCompacting()) return;
		const model = this.dependencies.getModel();
		if (!model) return;
		const settings = this.dependencies.settingsManager.getCompactionSettings();
		const runner = this.dependencies.getExtensionRunner();
		if (!settings.enabled && !runner.hasHandlers("compaction")) return;
		const branchEntries = this.dependencies.getBranch();
		const snapshotLeafId = this.dependencies.getLeafId();
		if (!snapshotLeafId) return;
		const preparation = prepareCompaction(branchEntries, settings);
		if (!preparation) return;
		const cache: BackgroundCompactionCache = {
			state: "pending",
			sessionId: this.dependencies.getSessionId(),
			snapshotLeafId,
			branchEntries,
			preparation,
			settings,
			model: { provider: model.provider, id: model.id, api: model.api },
			thinkingLevel: this.dependencies.getThinkingLevel(),
			systemPrompt: this.dependencies.getSystemPrompt(),
			extensionRunner: runner,
			abortController: new AbortController(),
		};
		this.cache = cache;
		cache.promise = this.generate(cache, model);
	}

	scheduleIdle(): void {
		this.clearIdleTimer();
		const target = this.findIdleTarget();
		if (!target) return;
		const delayMs = Math.max(0, target.dueAt - Date.now());
		this.idleTimer = setTimeout(() => void this.runIdleFor(target.message), delayMs);
		this.idleTimer.unref?.();
	}

	private findIdleTarget(): { message: AssistantMessage; dueAt: number } | undefined {
		if (this.dependencies.isDisposed() || this.dependencies.isObserver()) return undefined;
		const settingsAllowIdleCompaction =
			this.dependencies.settingsManager.getCompactionEnabled() &&
			this.dependencies.settingsManager.getIdleCompactionEnabled();
		if (!settingsAllowIdleCompaction) return undefined;
		const message = this.dependencies.findLastAssistantMessage();
		if (!message || message.stopReason === "error") return undefined;
		const model = this.dependencies.getModel();
		const isCurrentModel = !!model && this.dependencies.getModelRegistry().isMessageFromModel(message, model);
		if (!isCurrentModel) return undefined;
		const branchEntries = this.dependencies.getBranch();
		const compactionEntry = this.dependencies.getLatestCompactionEntry(branchEntries);
		if (this.dependencies.assistantMessagePrecedesCompaction(branchEntries, message, compactionEntry))
			return undefined;
		const dueAt = computeIdleCompactionDueAt(message);
		return dueAt === undefined ? undefined : { message, dueAt };
	}

	async runIdleFor(message: AssistantMessage): Promise<void> {
		this.idleTimer = undefined;
		await this.dependencies.withTurnStartLock(async () => {
			const hasQueuedInput = this.dependencies.hasPendingMessages() || this.dependencies.hasQueuedMessages();
			const sessionIsBusy =
				this.dependencies.getIsStreaming() || this.dependencies.isSessionCompacting() || hasQueuedInput;
			if (sessionIsBusy || this.findIdleTarget()?.message !== message) return;
			await this.dependencies.runAutoCompaction("idle", false);
		});
	}
}
