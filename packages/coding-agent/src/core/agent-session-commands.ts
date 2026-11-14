import type { ExtensionCommandContext, ResolvedCommand, ViewedSessionMutationTarget } from "./extensions/index.ts";
import { findExactModelReferenceMatch } from "./model-resolver.ts";
import { BUILTIN_SLASH_COMMANDS } from "./slash-commands.ts";

export type SessionMutationTargetResolver = () => ViewedSessionMutationTarget | undefined;

export interface ExtensionCommandOptions {
	expandPromptTemplates?: boolean;
	preflightResult?: (success: boolean) => void;
}

export function tryExecuteExtensionCommand(
	text: string,
	options: ExtensionCommandOptions | undefined,
	getCommand: (name: string) => ResolvedCommand | undefined,
	execute: (
		text: string,
		args: string,
		command: ResolvedCommand,
		options: ExtensionCommandOptions | undefined,
	) => Promise<void>,
): Promise<void> | undefined {
	const shouldExpandSlashCommand = (options?.expandPromptTemplates ?? true) && text.startsWith("/");
	if (!shouldExpandSlashCommand) return undefined;
	const spaceIndex = text.indexOf(" ");
	const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);
	const command = getCommand(commandName);
	if (!command) return undefined;
	return execute(text, args, command, options);
}

export async function executeExtensionCommand(
	text: string,
	args: string,
	command: ResolvedCommand,
	options: ExtensionCommandOptions | undefined,
	callbacks: {
		runBeforeRecovery: (text: string, options: ExtensionCommandOptions | undefined) => Promise<boolean>;
		createContext: (commandName: string) => ExtensionCommandContext;
		emitError: (error: unknown, commandName: string) => void;
		recordHistory: (text: string) => void;
	},
): Promise<void> {
	if (await callbacks.runBeforeRecovery(text, options)) return;
	try {
		await command.handler(args, callbacks.createContext(command.invocationName));
	} catch (error) {
		callbacks.emitError(error, command.invocationName);
	}
	callbacks.recordHistory(text);
	options?.preflightResult?.(true);
}

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
