import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	DEFAULT_MAX_RETRY_DELAY_MS,
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
/** Skip for a rate-limited member that gave no retry delay; per-minute limits reset within a minute. */
export const POOL_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

/** Account-scoped throttling another member can absorb, including OpenAI's per-minute "Request too large". */
const RATE_LIMIT_PATTERN = /rate.?limit|too many requests|\b429\b|(?:tokens|requests) per min/i;

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

/** A member skipped until `until`; `rateLimited` marks a short throttle rather than exhausted quota. */
interface MemberCooldown {
	until: number;
	rateLimited: boolean;
}

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

/** Registry-owned membership and member cooldowns; refresh rebuilds membership, not cooldowns. */
export class ModelPools {
	private members = new Map<string, Model<Api>[]>();
	private cooldowns = new Map<string, MemberCooldown>();
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

	/**
	 * Try members in order. Before output, a quota error, a rate limit, or a provider-requested wait beyond the cap
	 * moves to the next member and skips the failed one: rate limits for their retry delay, the rest for 15 minutes.
	 */
	private async routeMembers(request: PoolRequest): Promise<void> {
		const { model, context, options, output } = request;
		const maxRetryDelayMs = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
		let lastError: ErrorEvent | undefined;
		for (const member of this.getMembers(model)) {
			const auth = await this.resolveAvailableMember(member);
			if (options?.signal?.aborted) return;
			if (!auth) continue;
			request.active = member;
			const input = await request.streamMember(member, context, options, auth);
			const rotationError = await this.forwardMember(member, input, output, options?.signal, maxRetryDelayMs);
			if (!rotationError) return;
			lastError = rotationError;
			this.cooldowns.set(memberKey(member), memberCooldown(rotationError.error, maxRetryDelayMs, this.now()));
		}
		output.push(
			this.rateLimitedPoolError(model, lastError) ??
				lastError ??
				createError(model, `Pool "${model.id}": no eligible members available.`),
		);
	}

	/**
	 * When no member could serve but one is only rate limited, a retryable error naming the earliest free member;
	 * the caller's retry then reaches it instead of failing the turn.
	 */
	private rateLimitedPoolError(model: Model<Api>, lastError: ErrorEvent | undefined): ErrorEvent | undefined {
		const now = this.now();
		const waits = this.getMembers(model).flatMap((member) => {
			const cooldown = this.cooldowns.get(memberKey(member));
			return cooldown?.rateLimited && cooldown.until > now ? [cooldown.until - now] : [];
		});
		if (waits.length === 0) return undefined;
		const retryAfterMs = Math.min(...waits);
		const reason = lastError?.error.errorMessage ? ` Last error: ${lastError.error.errorMessage}` : "";
		const event = createError(
			model,
			`Pool "${model.id}": every member is rate limited or out of quota; the next frees in ${Math.ceil(retryAfterMs / 1000)}s.${reason}`,
		);
		event.error.retryAfterMs = retryAfterMs;
		return event;
	}

	/** Auth for a member that is not cooling down and has usable credentials; resolved once per attempt. */
	private async resolveAvailableMember(member: Model<Api>): Promise<MemberAuth | undefined> {
		if ((this.cooldowns.get(memberKey(member))?.until ?? 0) > this.now()) return undefined;
		if (!this.registry.hasConfiguredAuth(member)) return undefined;
		const auth = await this.registry.getApiKeyAndHeaders(member);
		return auth.ok ? auth : undefined;
	}

	/**
	 * A rotation error before any output is returned; everything else is forwarded unchanged.
	 * A stream that ends without done/error becomes an error.
	 */
	private async forwardMember(
		member: Model<Api>,
		input: AssistantMessageEventStream,
		output: AssistantMessageEventStream,
		signal: AbortSignal | undefined,
		maxRetryDelayMs: number,
	): Promise<ErrorEvent | undefined> {
		const events = input[Symbol.asyncIterator]();
		const first = await readUntilOutput(events, signal);
		if (!first) return undefined;
		if (first.event?.type === "error" && rotatesBeforeOutput(first.event.error, maxRetryDelayMs)) return first.event;
		let last = first.event;
		for (const event of [...first.starts, ...(first.event ? [first.event] : [])]) output.push(event);
		for (let next = await events.next(); !next.done && !signal?.aborted; next = await events.next()) {
			output.push(next.value);
			last = next.value;
		}
		const finished = last?.type === "done" || last?.type === "error";
		if (!finished && !signal?.aborted) {
			output.push(createError(member, `${memberKey(member)}: provider stream ended without a final event.`));
		}
		return undefined;
	}
}

/**
 * Rotation triggers before any output: terminal quota/balance exhaustion, an account rate limit,
 * or a requested retry delay longer than the cap, which makes the member unavailable for this request.
 */
function rotatesBeforeOutput(message: AssistantMessage, maxRetryDelayMs: number): boolean {
	return isQuotaExhaustionError(message) || isRateLimit(message) || exceedsRetryCap(message, maxRetryDelayMs);
}

function isRateLimit(message: AssistantMessage): boolean {
	return RATE_LIMIT_PATTERN.test(message.errorMessage ?? "");
}

function exceedsRetryCap(message: AssistantMessage, maxRetryDelayMs: number): boolean {
	if (message.retryAfterMs === undefined) return false;
	return maxRetryDelayMs > 0 && message.retryAfterMs > maxRetryDelayMs;
}

/** A rate limit within the retry cap skips the member for its retry delay; anything else for 15 minutes. */
function memberCooldown(message: AssistantMessage, maxRetryDelayMs: number, now: number): MemberCooldown {
	const throttled =
		!isQuotaExhaustionError(message) && isRateLimit(message) && !exceedsRetryCap(message, maxRetryDelayMs);
	if (!throttled) return { until: now + POOL_EXHAUSTION_COOLDOWN_MS, rateLimited: false };
	return { until: now + (message.retryAfterMs ?? POOL_RATE_LIMIT_COOLDOWN_MS), rateLimited: true };
}

/** Buffer `start` events until the first other event; undefined if aborted meanwhile. */
async function readUntilOutput(
	events: AsyncIterator<AssistantMessageEvent>,
	signal?: AbortSignal,
): Promise<{ starts: AssistantMessageEvent[]; event?: AssistantMessageEvent } | undefined> {
	const starts: AssistantMessageEvent[] = [];
	for (let next = await events.next(); !next.done; next = await events.next()) {
		if (signal?.aborted) return undefined;
		if (next.value.type !== "start") return { starts, event: next.value };
		starts.push(next.value);
	}
	return signal?.aborted ? undefined : { starts };
}
