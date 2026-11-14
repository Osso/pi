import type { ExtensionCommandContext, ViewedSessionMutationTarget } from "./extensions/index.ts";
import { BUILTIN_SLASH_COMMANDS } from "./slash-commands.ts";

export type SessionMutationTargetResolver = () => ViewedSessionMutationTarget | undefined;

export function slashCommandName(text: string): string {
	const match = text.match(/^\/([^\s]+)/);
	return `/${match?.[1] ?? ""}`;
}

export function isKnownSlashCommand(
	text: string,
	skills: readonly { name: string }[],
	promptTemplates: readonly { name: string }[],
): boolean {
	const commandName = slashCommandName(text).slice(1);
	if (BUILTIN_SLASH_COMMANDS.some((command) => command.name === commandName)) return true;
	if (commandName.startsWith("skill:")) {
		const skillName = commandName.slice("skill:".length);
		return skills.some((skill) => skill.name === skillName);
	}
	return promptTemplates.some((template) => template.name === commandName);
}

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
