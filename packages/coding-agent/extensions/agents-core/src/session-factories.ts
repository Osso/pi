import { existsSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "../../../src/config.ts";
import type { ExtensionContext, ExtensionFactory } from "../../../src/core/extensions/types.ts";
import type { AgentSnapshot, MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import type { CreateAgentSessionOptions } from "../../../src/core/sdk.ts";
import { restoreArchivedSession } from "../../../src/core/session-archive-storage.ts";
import { type SessionEntry, SessionManager } from "../../../src/core/session-manager.ts";
import { bindProductionChildSession } from "./child-session.ts";
import { createChildTools } from "./child-tools.ts";
import {
	type AttachedSessionFactory,
	CHILD_AGENT_CONTROL_TOOL_NAMES,
	CHILD_EXCLUDED_TOOL_NAMES,
	type ChildAgentDispatchInput,
	type ChildAgentSessionFactory,
	type GoalObjectiveValidation,
	MAX_GOAL_OBJECTIVE_CHARS,
	type ProductionChildAgentSessionFactory,
	type ProductionChildAgentSessionFactoryOptions,
	productionChildSessionFactoryMarker,
	type ResolvedAgentProfile,
	THINKING_LEVELS,
} from "./contracts.ts";

const GOAL_EXTENSION_PATH = "<first-party:goal>";
const EXPLORE_CONSULTATION_TOOLS = ["read", "grep", "find", "ls", "outline", "symbol", "references", "end_turn"];
const artifactRootsByStore = new WeakMap<MultiAgentStore, string>();

function toThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	return value && THINKING_LEVELS.has(value as ThinkingLevel) ? (value as ThinkingLevel) : undefined;
}

export function validateGoalObjective(prompt: string): GoalObjectiveValidation {
	const objective = prompt.trim();
	if (!objective) {
		return { length: 0, ok: false, reason: "empty" };
	}
	if (objective.length > MAX_GOAL_OBJECTIVE_CHARS) {
		return { length: objective.length, ok: false, reason: "too_long" };
	}
	return { objective, ok: true };
}

export function isProductionChildSessionFactory(
	factory: ChildAgentSessionFactory | undefined,
): factory is ProductionChildAgentSessionFactory {
	return (
		(factory as Partial<ProductionChildAgentSessionFactory> | undefined)?.[productionChildSessionFactoryMarker] ===
		true
	);
}

export function spawnPromptValidationMessage(validation: Exclude<GoalObjectiveValidation, { ok: true }>): string {
	return validation.reason === "empty"
		? "spawn_agent requires a non-empty prompt"
		: `spawn_agent prompt too long (${validation.length} > ${MAX_GOAL_OBJECTIVE_CHARS} chars)`;
}

export function artifactRootForStore(store: MultiAgentStore): string {
	return artifactRootsByStore.get(store) ?? getAgentDir();
}

export function resolveChildExtensionFactories(
	extensionFactories: ProductionChildAgentSessionFactoryOptions["extensionFactories"],
): ExtensionFactory[] | undefined {
	const factories = typeof extensionFactories === "function" ? extensionFactories() : extensionFactories;
	return factories?.filter(
		(factory) => (factory as ExtensionFactory & { extensionPath?: string }).extensionPath !== GOAL_EXTENSION_PATH,
	);
}

export function getSessionTranscriptMetadata(
	sessionManager: NonNullable<CreateAgentSessionOptions["sessionManager"]>,
): AgentSnapshot["transcript"] {
	return {
		path: sessionManager.getSessionFile(),
		sessionId: sessionManager.getSessionId(),
	};
}

export function findActiveToolCallEntry(branch: SessionEntry[], activeToolCallId: string): SessionEntry | undefined {
	return [...branch]
		.reverse()
		.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some((part) => part.type === "toolCall" && part.id === activeToolCallId),
		);
}

export function findUnresolvedTurnParentId(branch: SessionEntry[], activeToolEntry: SessionEntry): string | null {
	const immediateParent = branch.find((entry) => entry.id === activeToolEntry.parentId);
	if (immediateParent?.type === "message" && immediateParent.message.role === "assistant") {
		return immediateParent.id;
	}

	let ancestor = immediateParent;
	while (ancestor) {
		if (ancestor.type === "message" && ancestor.message.role === "user") return ancestor.parentId;
		ancestor = branch.find((entry) => entry.id === ancestor?.parentId);
	}
	return activeToolEntry.parentId;
}

export function resolveInheritedLeafId(
	context: ChildAgentDispatchInput["context"],
	activeToolCallId: string | undefined,
	sessionManager: ExtensionContext["sessionManager"],
): string | null | undefined {
	if (activeToolCallId !== undefined && activeToolCallId.trim() === "") {
		throw new Error("Cannot inherit context: active tool call identity must be non-empty");
	}
	if (!activeToolCallId) return sessionManager.getLeafId() ?? undefined;

	const branch = sessionManager.getBranch();
	const activeToolEntry = findActiveToolCallEntry(branch, activeToolCallId);
	if (activeToolEntry) return findUnresolvedTurnParentId(branch, activeToolEntry);
	if (context === "inherit") {
		throw new Error(`Cannot inherit context: active tool call ${activeToolCallId} is not in the parent branch`);
	}
	return sessionManager.getLeafId() ?? undefined;
}

export function createChildSessionManager(input: {
	activeToolCallId?: string;
	agent: AgentSnapshot;
	context: ChildAgentDispatchInput["context"];
	ctx: ExtensionContext;
	options: ProductionChildAgentSessionFactoryOptions;
}): {
	parentSessionFile: string | undefined;
	sessionManager: NonNullable<CreateAgentSessionOptions["sessionManager"]>;
} {
	const parentSessionFile = input.ctx.sessionManager.getSessionFile();
	if (input.context === "inherit" && !parentSessionFile) {
		throw new Error("Cannot inherit context from an unpersisted parent session");
	}
	const sessionDir = input.options.sessionDir ?? input.ctx.sessionManager.getSessionDir();
	const childSessionOptions = {
		parentSession: parentSessionFile ?? input.ctx.sessionManager.getSessionId(),
		isSubagent: true,
		subagentName: input.agent.displayName,
	};
	const inheritedLeafId = resolveInheritedLeafId(input.context, input.activeToolCallId, input.ctx.sessionManager);
	const sessionManager =
		input.context === "inherit" && parentSessionFile
			? SessionManager.forkFrom(parentSessionFile, input.agent.cwd, sessionDir, childSessionOptions, inheritedLeafId)
			: input.options.createSessionManager(input.agent.cwd, sessionDir, childSessionOptions);
	return { parentSessionFile, sessionManager };
}

export function createProductionChildAgentSessionFactory(
	options: ProductionChildAgentSessionFactoryOptions,
): ChildAgentSessionFactory {
	if (options.multiAgentStore && options.agentDir) artifactRootsByStore.set(options.multiAgentStore, options.agentDir);
	const factory: ProductionChildAgentSessionFactory = async ({ activeToolCallId, agent, context, ctx, prompt }) => {
		const validation = validateGoalObjective(prompt);
		if (!validation.ok) {
			throw new Error(spawnPromptValidationMessage(validation));
		}
		const { parentSessionFile, sessionManager } = createChildSessionManager({
			activeToolCallId,
			agent,
			context,
			ctx,
			options,
		});
		const sessionStartEvent = parentSessionFile
			? { type: "session_start" as const, reason: "fork" as const, previousSessionFile: parentSessionFile }
			: { type: "session_start" as const, reason: "fork" as const };
		const result = await options.createSession({
			...childSessionOptions(options, agent, ctx),
			sessionManager,
			sessionStartEvent,
		});

		await result.session.bindExtensions({});
		sessionManager.persistForRecovery();
		result.session.transcript = getSessionTranscriptMetadata(sessionManager);
		return bindProductionChildSession(result.session, !agent.exploreConsultation);
	};
	factory[productionChildSessionFactoryMarker] = true;
	return factory;
}

export function createProductionAttachedSessionFactory(
	options: Omit<ProductionChildAgentSessionFactoryOptions, "createSessionManager">,
): AttachedSessionFactory {
	if (options.multiAgentStore && options.agentDir) artifactRootsByStore.set(options.multiAgentStore, options.agentDir);
	return async ({ agent, ctx, sessionPath }) => {
		if (!sessionPath) {
			throw new Error("Cannot resume attached session without a session path");
		}
		sessionPath = ctx.controlDbPath ? restoreArchivedSession(ctx.controlDbPath, sessionPath) : sessionPath;
		if (!existsSync(sessionPath)) {
			throw new Error(`Child agent transcript does not exist: ${sessionPath}`);
		}
		if (agent.cwd !== ctx.cwd && !existsSync(agent.cwd)) {
			throw new Error(`Agent ${agent.id} working directory does not exist: ${agent.cwd}`);
		}
		const sessionDir = options.sessionDir ?? ctx.sessionManager.getSessionDir();
		const sessionManager = SessionManager.open(sessionPath, sessionDir, agent.cwd);
		const expectedSessionId = agent.transcript?.sessionId;
		const actualSessionId = sessionManager.getSessionId();
		if (expectedSessionId !== undefined && actualSessionId !== expectedSessionId) {
			throw new Error(
				`Child agent transcript session mismatch: expected ${expectedSessionId}, found ${actualSessionId}`,
			);
		}
		sessionManager.setMetadataControlDbPath(ctx.controlDbPath);
		const parentSessionFile = ctx.sessionManager.getSessionFile();
		const sessionStartEvent = parentSessionFile
			? { type: "session_start" as const, reason: "resume" as const, previousSessionFile: parentSessionFile }
			: { type: "session_start" as const, reason: "resume" as const };
		const result = await options.createSession({
			...childSessionOptions(options, agent, ctx),
			sessionManager,
			sessionStartEvent,
		});

		await result.session.bindExtensions({});
		result.session.transcript = getSessionTranscriptMetadata(sessionManager);
		return bindProductionChildSession(result.session, !agent.exploreConsultation);
	};
}

export function resolveChildAgentProfile(agent: AgentSnapshot, ctx: ExtensionContext): ResolvedAgentProfile {
	const configuredModel = agent.model
		? ctx.modelRegistry.find(agent.model.providerId, agent.model.modelId)
		: undefined;
	return {
		model: configuredModel,
		thinkingLevel: toThinkingLevel(agent.model?.thinkingLevel),
		tools: ctx.settingsManager?.getAgentProfile(agent.agentType)?.tools,
	};
}

function childSessionOptions(
	options: Omit<ProductionChildAgentSessionFactoryOptions, "createSessionManager">,
	agent: AgentSnapshot,
	ctx: ExtensionContext,
): CreateAgentSessionOptions {
	const profile = resolveChildAgentProfile(agent, ctx);
	return {
		agentDir: options.agentDir,
		customTools: createChildTools(
			agent,
			options.browserAgentConfigRoot,
			ctx.settingsManager?.getAgentProfile(agent.agentType)?.implementAs,
		),
		cwd: agent.cwd,
		excludeTools: CHILD_EXCLUDED_TOOL_NAMES,
		extensionFactories: resolveChildExtensionFactories(options.extensionFactories),
		model: profile.model ?? ctx.model,
		modelRegistry: ctx.modelRegistry,
		tools: resolveChildAgentTools(agent, profile.tools),
		multiAgentAgentId: agent.id,
		multiAgentParentSessionId: ctx.sessionManager.getSessionId(),
		multiAgentRequiresAgentId: true,
		multiAgentRuntimeRole: "child",
		multiAgentStore: options.multiAgentStore,
		thinkingLevel: profile.thinkingLevel,
	};
}

function resolveChildAgentTools(agent: AgentSnapshot, tools: string[] | undefined): string[] | undefined {
	if (agent.exploreConsultation) return EXPLORE_CONSULTATION_TOOLS.filter((name) => !tools || tools.includes(name));
	if (!tools) return undefined;
	const requiredTools =
		agent.agentType === "browser" ? [...CHILD_AGENT_CONTROL_TOOL_NAMES, "read"] : CHILD_AGENT_CONTROL_TOOL_NAMES;
	return [...new Set([...tools, ...requiredTools])];
}
