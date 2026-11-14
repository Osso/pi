import type { ExtensionCommandContext, ViewedSessionMutationTarget } from "./extensions/index.ts";
import { findExactModelReferenceMatch } from "./model-resolver.ts";
import { recordPromptHistoryEntry } from "./session-control-db.ts";

export type SessionMutationTargetResolver = () => ViewedSessionMutationTarget | undefined;

export function recordHandledSlashCommandHistory(controlDbPath: string, text: string): void {
	try {
		recordPromptHistoryEntry(controlDbPath, text);
	} catch (error) {
		console.error(
			"Failed to persist prompt history for handled slash command:",
			error instanceof Error ? error.message : String(error),
		);
	}
}

const sessionMutationTargetResolvers = new WeakMap<object, SessionMutationTargetResolver>();

export function bindSessionMutationTargetResolver(session: object, resolver: SessionMutationTargetResolver): void {
	sessionMutationTargetResolvers.set(session, resolver);
}

export function createInternalCommands(): ReadonlyMap<
	string,
	(args: string, context: ExtensionCommandContext) => Promise<void>
> {
	return new Map([
		[
			"model",
			async (args: string, context: ExtensionCommandContext) => {
				const modelReference = args.trim();
				if (!modelReference) return;
				const scopedModels = context.getScopedModels?.() ?? [];
				const models =
					scopedModels.length > 0
						? scopedModels.map((scoped) => scoped.model)
						: context.modelRegistry.getAvailable();
				const model = findExactModelReferenceMatch(modelReference, models);
				if (!model) throw new Error(`Model not found or not authenticated: ${modelReference}`);
				if (!(await context.setModel(model))) {
					throw new Error(`No API key for ${model.provider}/${model.id}`);
				}
			},
		],
	]);
}

export function createViewedSessionCommandContext(
	context: ExtensionCommandContext,
	session: object,
): ExtensionCommandContext {
	const owningModel = context.model;
	const owningModelRegistry = context.modelRegistry;
	const owningScopedModels = context.getScopedModels;
	const owningGetThinkingLevel = context.getThinkingLevel;
	const owningSetModel = context.setModel;
	const owningSetThinkingLevel = context.setThinkingLevel;
	const resolveViewedTarget = (): ViewedSessionMutationTarget | undefined =>
		sessionMutationTargetResolvers.get(session)?.();

	Object.defineProperty(context, "model", {
		configurable: true,
		enumerable: true,
		get: () => {
			const target = resolveViewedTarget();
			return target ? target.model : owningModel;
		},
	});
	Object.defineProperty(context, "modelRegistry", {
		configurable: true,
		enumerable: true,
		get: () => {
			const target = resolveViewedTarget();
			return target ? target.modelRegistry : owningModelRegistry;
		},
	});
	context.getScopedModels = () => {
		const target = resolveViewedTarget();
		return target ? target.scopedModels : (owningScopedModels?.() ?? []);
	};
	context.getThinkingLevel = () => resolveViewedTarget()?.thinkingLevel ?? owningGetThinkingLevel();
	context.setModel = async (model) => {
		const target = resolveViewedTarget();
		if (!target) return owningSetModel(model);
		await target.setModel(model);
		return true;
	};
	context.setThinkingLevel = (level) => {
		const target = resolveViewedTarget();
		if (target) target.setThinkingLevel(level);
		else owningSetThinkingLevel(level);
	};
	return context;
}
