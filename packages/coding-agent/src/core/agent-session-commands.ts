import type { ExtensionCommandContext, ViewedSessionMutationTarget } from "./extensions/index.ts";

export type SessionMutationTargetResolver = () => ViewedSessionMutationTarget | undefined;

const sessionMutationTargetResolvers = new WeakMap<object, SessionMutationTargetResolver>();

export function bindSessionMutationTargetResolver(session: object, resolver: SessionMutationTargetResolver): void {
	sessionMutationTargetResolvers.set(session, resolver);
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
