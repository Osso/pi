import {
	type Api,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
	registerApiProvider,
	type SimpleStreamOptions,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { isQuotaExhaustionError } from "./codex-quota-fallback.ts";
import type { ModelRegistry, ResolvedRequestAuth } from "./model-registry.ts";

export const POOL_EXHAUSTION_COOLDOWN_MS = 15 * 60 * 1000;

export type MemberAuth = Extract<ResolvedRequestAuth, { ok: true }>;

/** Streams one member with auth the pool already resolved; the SDK passes its per-model request path. */
export type PoolMemberStream = (
	member: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	auth: MemberAuth,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

const THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
type ErrorEvent = Extract<AssistantMessageEvent, { type: "error" }>;

function createPoolModel(name: string, members: Model<Api>[]): Model<Api> {
	const first = members[0];
	const supportedLevels = members.map((member) => getSupportedThinkingLevels(member));
	const thinkingLevelMap: NonNullable<Model<Api>["thinkingLevelMap"]> = {};
	for (const level of THINKING_LEVELS) {
		thinkingLevelMap[level] = supportedLevels.every((levels) => levels.includes(level)) ? level : null;
	}
	return {
		provider: "pool",
		id: name,
		name: `Pool ${name}`,
		api: "pool",
		baseUrl: "",
		contextWindow: Math.min(...members.map((member) => member.contextWindow)),
		maxTokens: Math.min(...members.map((member) => member.maxTokens)),
		input: first.input.filter((input) => members.every((member) => member.input.includes(input))),
		reasoning: members.every((member) => member.reasoning),
		thinkingLevelMap,
		cost: { ...first.cost },
	};
}

function createError(model: Model<Api>, errorMessage: string, reason: "error" | "aborted" = "error"): ErrorEvent {
	return {
		type: "error",
		reason,
		error: {
			role: "assistant",
			provider: model.provider,
			model: model.id,
			api: model.api,
			content: [],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: reason,
			errorMessage,
			timestamp: Date.now(),
		},
	};
}

interface PoolRequest {
	model: Model<Api>;
	context: Context;
	options?: SimpleStreamOptions;
	streamMember: PoolMemberStream;
	output: AssistantMessageEventStream;
	/** Identity for an abort or thrown error: the member being tried, else the pool. */
	active: Model<Api>;
}

/** Pool models belong to the registry that built them; pi-ai's single "pool" API dispatches through this. */
const poolOwners = new WeakMap<Model<Api>, ModelPools>();

function streamOwnedPool(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
	const owner = poolOwners.get(model);
	if (owner) return owner.stream(model, context, options);
	const output = createAssistantMessageEventStream();
	output.push(createError(model, `Pool "${model.id}" was not loaded by a model registry.`));
	output.end();
	return output;
}

function memberKey(member: Model<Api>): string {
	return `${member.provider}/${member.id}`;
}

/** Direct pi-ai calls without the SDK; caller headers/env win over member auth, as in the SDK path. */
const streamWithMemberAuth: PoolMemberStream = (member, context, options, auth) =>
	streamSimple(member, context, {
		...options,
		apiKey: auth.apiKey,
		headers: auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined,
		env: auth.env || options?.env ? { ...auth.env, ...options?.env } : undefined,
	});

/** Registry-owned membership and quota cooldowns; refresh rebuilds membership, not cooldowns. */
export class ModelPools {
	private members = new Map<string, Model<Api>[]>();
	private exhaustedUntil = new Map<string, number>();
	private registry: ModelRegistry;
	private now: () => number;

	constructor(registry: ModelRegistry, now: () => number) {
		this.registry = registry;
		this.now = now;
	}

	configure(pools: Record<string, string[]>, models: Model<Api>[]): { models: Model<Api>[]; errors: string[] } {
		this.members.clear();
		const poolModels: Model<Api>[] = [];
		const errors: string[] = [];
		for (const [name, refs] of Object.entries(pools)) {
			const members = refs.flatMap((ref) => {
				const slash = ref.indexOf("/");
				if (slash < 1) return [];
				const provider = ref.slice(0, slash);
				const id = ref.slice(slash + 1);
				const model = models.find((candidate) => candidate.provider === provider && candidate.id === id);
				return model && model.provider !== "pool" && model.api !== "pool" ? [model] : [];
			});
			if (members.length === 0) {
				errors.push(`Pool "${name}": no members resolve in the model registry.`);
				continue;
			}
			this.members.set(name, members);
			const poolModel = createPoolModel(name, members);
			poolOwners.set(poolModel, this);
			poolModels.push(poolModel);
		}
		registerApiProvider(
			{
				api: "pool",
				stream: (model, context, options) => streamOwnedPool(model, context, options as SimpleStreamOptions),
				streamSimple: streamOwnedPool,
			},
			"provider:pool",
		);
		return { models: poolModels, errors };
	}

	getMembers(model: Model<Api>): Model<Api>[] {
		return model.provider === "pool" ? (this.members.get(model.id) ?? []) : [];
	}

	stream(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
		streamMember: PoolMemberStream = streamWithMemberAuth,
	): AssistantMessageEventStream {
		const request: PoolRequest = {
			model,
			context,
			options,
			streamMember,
			output: createAssistantMessageEventStream(),
			active: model,
		};
		const { output } = request;
		const signal = options?.signal;
		const abort = () => {
			output.push(createError(request.active, "Request aborted", "aborted"));
			output.end();
		};
		if (signal?.aborted) {
			abort();
			return output;
		}
		signal?.addEventListener("abort", abort, { once: true });
		this.routeMembers(request)
			.catch((error) =>
				output.push(createError(request.active, error instanceof Error ? error.message : String(error))),
			)
			.finally(() => {
				signal?.removeEventListener("abort", abort);
				output.end();
			});
		return output;
	}

	/** Try members in order; only a quota error before output moves to the next one. */
	private async routeMembers(request: PoolRequest): Promise<void> {
		const { model, context, options, output } = request;
		let lastError: ErrorEvent | undefined;
		for (const member of this.getMembers(model)) {
			const auth = await this.resolveAvailableMember(member);
			if (options?.signal?.aborted) return;
			if (!auth) continue;
			request.active = member;
			const input = await request.streamMember(member, context, options, auth);
			const quotaError = await this.forwardMember(member, input, output, options?.signal);
			if (!quotaError) return;
			lastError = quotaError;
			this.exhaustedUntil.set(memberKey(member), this.now() + POOL_EXHAUSTION_COOLDOWN_MS);
		}
		output.push(lastError ?? createError(model, `Pool "${model.id}": no eligible members available.`));
	}

	/** Auth for a member that is not cooling down and has usable credentials; resolved once per attempt. */
	private async resolveAvailableMember(member: Model<Api>): Promise<MemberAuth | undefined> {
		if ((this.exhaustedUntil.get(memberKey(member)) ?? 0) > this.now()) return undefined;
		if (!this.registry.hasConfiguredAuth(member)) return undefined;
		const auth = await this.registry.getApiKeyAndHeaders(member);
		return auth.ok ? auth : undefined;
	}

	/**
	 * Buffer `start` until the first other event. A quota error there is returned for rotation;
	 * anything else is forwarded unchanged. A stream that ends without done/error becomes an error.
	 */
	private async forwardMember(
		member: Model<Api>,
		input: AssistantMessageEventStream,
		output: AssistantMessageEventStream,
		signal?: AbortSignal,
	): Promise<ErrorEvent | undefined> {
		const buffered: AssistantMessageEvent[] = [];
		let forwarding = false;
		let finished = false;
		for await (const event of input) {
			if (signal?.aborted) return;
			if (!forwarding) {
				if (event.type === "start") {
					buffered.push(event);
					continue;
				}
				if (event.type === "error" && isQuotaExhaustionError(event.error)) return event;
				for (const start of buffered) output.push(start);
				forwarding = true;
			}
			output.push(event);
			finished = event.type === "done" || event.type === "error";
		}
		if (!finished && !signal?.aborted) {
			output.push(createError(member, `${memberKey(member)}: provider stream ended without a final event.`));
		}
		return undefined;
	}
}
