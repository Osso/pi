import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { DEFAULT_THINKING_LEVEL } from "../../../src/core/defaults.ts";
import type { AgentToolResult, ExtensionCommandContext, ExtensionContext } from "../../../src/core/extensions/types.ts";
import type { OwnedLifecycleCommandInput } from "../../../src/core/lifecycle-coordinator.ts";
import { findExactModelReferenceMatch } from "../../../src/core/model-resolver.ts";
import type { AgentSnapshot, MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import type { ActiveAgentDispatches, BackgroundSessionHandles, OwnedAgentRuntime } from "./contracts.ts";
import {
	type AgentDesktopNotifier,
	type AgentToolDetails,
	CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE,
	type ChildAgentSession,
	type ChildAgentSessionFactory,
	type GoalObjectiveValidation,
	MAX_GOAL_OBJECTIVE_CHARS,
	type ResolvedAgentProfile,
	requireSpawnAgentParams,
} from "./contracts.ts";
import type { WaitingDesktopNotificationHandles } from "./dispatch-pipeline.ts";
import {
	publishCoordinatorSnapshot,
	runAgentSession,
	startToolDispatch,
	trackAgentDispatch,
} from "./dispatch-pipeline.ts";
import { createLifecycleCoordinator } from "./lifecycle-runtime.ts";
import { emptyAgent, result } from "./messaging.ts";
import {
	isProductionChildSessionFactory,
	spawnPromptValidationMessage,
	validateGoalObjective,
} from "./session-factories.ts";

export interface BackgroundDispatchContext {
	createChildSession: ChildAgentSessionFactory | undefined;
	dispatches: ActiveAgentDispatches;
	handles: BackgroundSessionHandles;
	ownerships: Map<string, OwnedAgentRuntime>;
	store: MultiAgentStore;
}

export function emptyResult(): AgentToolResult<Record<string, never>> {
	return { content: [], details: {} };
}

export function notifyBackgroundDispatch(
	promise: Promise<AgentSnapshot>,
	handles: BackgroundSessionHandles,
	ctx: ExtensionCommandContext,
): void {
	void promise.then((agent) => {
		handles.delete(agent.id);
		const level = agent.lifecycle === "completed" ? "info" : agent.lifecycle === "failed" ? "error" : "warning";
		ctx.ui.notify(formatAgentStatus(agent), level);
	});
}

export function backgroundPromptValidationMessage(validation: Exclude<GoalObjectiveValidation, { ok: true }>): string {
	return validation.reason === "empty"
		? "Usage: /bg <prompt>"
		: `Objective too long (${validation.length} > ${MAX_GOAL_OBJECTIVE_CHARS} chars)`;
}

export function startBackgroundDispatch(
	background: BackgroundDispatchContext,
	runtime: OwnedAgentRuntime,
	prompt: string,
	ctx: ExtensionCommandContext,
	createdSession?: ChildAgentSession,
): AgentSnapshot {
	const agent = runtime.lifecycle.agent;
	if (background.createChildSession) {
		const promise = trackAgentDispatch(
			background.store,
			background.dispatches,
			agent,
			runAgentSession(
				background.store,
				background.createChildSession,
				agent,
				prompt,
				ctx,
				background.handles,
				createdSession,
				runtime,
			),
			runtime,
			background.handles,
		);
		notifyBackgroundDispatch(promise, background.handles, ctx);
		void promise.finally(() => background.ownerships.delete(agent.id));
		return background.store.getAgent(agent.id) ?? agent;
	}

	return agent;
}

export async function backgroundCommand(
	background: BackgroundDispatchContext,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (isChildAgentRuntime(ctx)) {
		ctx.ui.notify(CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE, "error");
		return;
	}
	const prompt = args.trim();
	if (!background.createChildSession) {
		ctx.ui.notify("Background jobs are unavailable: no child session runtime is configured.", "error");
		return;
	}
	if (isProductionChildSessionFactory(background.createChildSession)) {
		const validation = validateGoalObjective(prompt);
		if (!validation.ok) {
			ctx.ui.notify(backgroundPromptValidationMessage(validation), "error");
			return;
		}
	}

	const coordinator = createLifecycleCoordinator(background.store);
	if (!coordinator) {
		ctx.ui.notify("Background jobs require a persisted supervisor session.", "error");
		return;
	}
	let prepared = coordinator.prepareChild({
		agentType: "background",
		cwd: ctx.cwd,
		displayName: "Background Job",
		permission: { narrowed: true, policy: "on-request" },
	});
	const abortController = new AbortController();
	let childSession: ChildAgentSession | undefined;
	if (background.createChildSession) {
		try {
			childSession = await background.createChildSession({
				agent: prepared,
				context: "fresh",
				ctx,
				prompt,
				signal: abortController.signal,
			});
		} catch (error) {
			const runtimeError = {
				code: "runtime_spawn_failed",
				message: error instanceof Error ? error.message : String(error),
			};
			const failed = coordinator.commitFailedChild(prepared, runtimeError);
			if (failed.ok) publishCoordinatorSnapshot(background.store, failed.agent);
			ctx.ui.notify(`Could not create background job: ${runtimeError.message}`, "error");
			return;
		}
		if (childSession.transcript) prepared = { ...prepared, transcript: childSession.transcript };
	}
	const created = coordinator.commitRunningChild(
		prepared,
		ctx.sessionManager?.getSessionId() ?? background.store.getPersistenceTarget()?.sessionPath ?? "",
	);
	if (!created.ok) {
		await childSession?.dispose?.();
		ctx.ui.notify(`Could not create background job: ${created.error}`, "error");
		return;
	}
	background.store.publishLifecycleCoordinatorSnapshot(created.agent);
	const runtime = {
		abortController,
		coordinator,
		lifecycle: { agent: created.agent, ownership: created.ownership },
	};
	background.ownerships.set(created.agent.id, runtime);
	const agent = startBackgroundDispatch(background, runtime, prompt, ctx, childSession);
	ctx.ui.setEditorText("");
	ctx.ui.notify(
		`Background job ${agent.id} started. Use /jobs to inspect it or wait_agent to wait for any completion.`,
		"info",
	);
}

export function spawnModelMetadata(
	profile: ResolvedAgentProfile | undefined,
	ctx: ExtensionContext,
): AgentSnapshot["model"] {
	const model = profile?.model ?? ctx.model;
	if (!model) return undefined;
	const thinkingLevel = clampThinkingLevel(model, profile?.thinkingLevel ?? DEFAULT_THINKING_LEVEL) as ThinkingLevel;
	return { providerId: model.provider, modelId: model.id, thinkingLevel };
}

export function resolveConfiguredAgentProfile(
	agentType: string,
	ctx: ExtensionContext,
): ResolvedAgentProfile | undefined {
	const profile = ctx.settingsManager?.getAgentProfile(agentType);
	if (!profile) {
		return undefined;
	}

	const model = profile.model ? findExactModelReferenceMatch(profile.model, ctx.modelRegistry.getAll()) : undefined;
	return {
		context: profile.context,
		model,
		modelMetadata: model
			? { providerId: model.provider, modelId: model.id, thinkingLevel: profile.thinkingLevel }
			: undefined,
		thinkingLevel: profile.thinkingLevel,
		tools: profile.tools,
	};
}

export function requireConfiguredAgentProfile(
	agentType: string,
	requestedAgentType: string | undefined,
	ctx: ExtensionContext,
): ResolvedAgentProfile | undefined {
	const profile = resolveConfiguredAgentProfile(agentType, ctx);
	if (!requestedAgentType) return profile;
	if (!ctx.settingsManager) return profile;
	if (profile) return profile;

	const configuredAgentTypes = Object.keys(ctx.settingsManager.getMergedSettings().agents ?? {}).sort();
	const guidance =
		configuredAgentTypes.length > 0
			? `Configured agent profiles: ${configuredAgentTypes.join(", ")}. Use one of these profile keys or omit agentType to inherit the parent model.`
			: "Configure the profile under settings.agents or omit agentType to inherit the parent model.";
	throw new Error(`Unknown agent type ${JSON.stringify(agentType)}. ${guidance}`);
}

export function isChildAgentRuntime(ctx: ExtensionContext): boolean {
	return ctx.multiAgentAgentId !== undefined || ctx.multiAgentRequiresAgentId === true;
}

export async function spawnAgent(
	store: MultiAgentStore,
	createChildSession: ChildAgentSessionFactory | undefined,
	dispatches: ActiveAgentDispatches,
	ownerships: Map<string, OwnedAgentRuntime>,
	params: unknown,
	ctx: ExtensionContext,
	desktopNotifier: AgentDesktopNotifier,
	waitingDesktopNotifications: WaitingDesktopNotificationHandles,
	handles?: BackgroundSessionHandles,
	activeToolCallId?: string,
): Promise<AgentToolResult<AgentToolDetails>> {
	requireSpawnAgentParams(params);
	if (isChildAgentRuntime(ctx)) {
		return result(CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE, {
			agent: emptyAgent("spawn_agent"),
			dispatched: false,
			prompt: params.prompt,
		});
	}
	if (isProductionChildSessionFactory(createChildSession)) {
		const validation = validateGoalObjective(params.prompt);
		if (!validation.ok) {
			return result(spawnPromptValidationMessage(validation), {
				agent: emptyAgent("spawn_agent"),
				dispatched: false,
				prompt: params.prompt,
			});
		}
	}
	if (!createChildSession) {
		return result("spawn_agent is unavailable: no child session runtime is configured.", {
			agent: emptyAgent("spawn_agent"),
			dispatched: false,
			prompt: params.prompt,
		});
	}
	const requestedAgentType = params.agentType?.trim();
	const displayName = params.displayName?.trim() || requestedAgentType || "Agent";
	const agentType = requestedAgentType || "default";
	const profile = requireConfiguredAgentProfile(agentType, requestedAgentType, ctx);
	const context = params.context ?? profile?.context ?? "inherit";
	const coordinator = createLifecycleCoordinator(store);
	if (!coordinator) {
		return result("spawn_agent requires a persisted supervisor session.", {
			agent: emptyAgent("spawn_agent"),
			dispatched: false,
			prompt: params.prompt,
		});
	}
	let prepared = coordinator.prepareChild({
		agentType,
		cwd: ctx.cwd,
		displayName,
		model: spawnModelMetadata(profile, ctx),
		parentId: params.parentId,
		permission: { narrowed: true, policy: "on-request" },
	});
	const abortController = new AbortController();
	let childSession: ChildAgentSession | undefined;
	if (createChildSession) {
		try {
			childSession = await createChildSession({
				activeToolCallId,
				agent: prepared,
				context,
				ctx,
				prompt: params.prompt,
				signal: abortController.signal,
			});
		} catch (error) {
			const runtimeError = {
				code: "runtime_spawn_failed",
				message: error instanceof Error ? error.message : String(error),
			};
			const failed = coordinator.commitFailedChild(prepared, runtimeError);
			if (failed.ok) publishCoordinatorSnapshot(store, failed.agent);
			return result(`spawn_agent failed to construct child session: ${runtimeError.message}`, {
				agent: failed.ok ? failed.agent : prepared,
				dispatched: false,
				prompt: params.prompt,
			});
		}
		if (childSession.transcript) prepared = { ...prepared, transcript: childSession.transcript };
	}
	const created = coordinator.commitRunningChild(
		prepared,
		ctx.sessionManager?.getSessionId() ?? store.getPersistenceTarget()?.sessionPath ?? "",
	);
	if (!created.ok) {
		await childSession?.dispose?.();
		return result(`spawn_agent failed: ${created.error}`, {
			agent: prepared,
			dispatched: false,
			prompt: params.prompt,
		});
	}
	store.publishLifecycleCoordinatorSnapshot(created.agent);
	const lifecycle: OwnedLifecycleCommandInput = { agent: created.agent, ownership: created.ownership };
	const runtime = { abortController, coordinator, lifecycle };
	ownerships.set(created.agent.id, runtime);

	if (createChildSession && childSession) {
		const restoreGeneration = store.getRestoreGeneration();
		const agent = startToolDispatch(
			store,
			dispatches,
			created.agent,
			() =>
				runAgentSession(
					store,
					createChildSession,
					created.agent,
					params.prompt,
					ctx,
					handles,
					childSession,
					runtime,
					restoreGeneration,
				),
			desktopNotifier,
			waitingDesktopNotifications,
			handles,
			runtime,
		);
		releaseOwnershipAfterDispatch(dispatches, ownerships, agent.id);
		return result(`Spawned ${agent.displayName} (${agent.id}) [type: ${agent.agentType}, context: ${context}]`, {
			agent,
			dispatched: true,
			prompt: params.prompt,
		});
	}

	throw new Error("spawn_agent child session runtime invariant violated");
}

export function releaseOwnershipAfterDispatch(
	dispatches: ActiveAgentDispatches,
	ownerships: Map<string, OwnedAgentRuntime>,
	agentId: string,
): void {
	const dispatch = dispatches.get(agentId);
	if (dispatch) void dispatch.finally(() => ownerships.delete(agentId));
}

export function formatAgentStatus(agent: AgentSnapshot): string {
	const summary = agent.result?.summary?.trim();
	if (summary) {
		return `${agent.displayName} is ${agent.lifecycle}: ${summary}`;
	}

	const errorMessage = agent.error?.message?.trim();
	if (errorMessage) {
		return `${agent.displayName} is ${agent.lifecycle}: ${errorMessage}`;
	}

	return `${agent.displayName} is ${agent.lifecycle}.`;
}
