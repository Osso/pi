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
import type { ModelRegistry } from "./model-registry.ts";

export const POOL_EXHAUSTION_COOLDOWN_MS = 15 * 60 * 1000;

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
			poolModels.push(createPoolModel(name, members));
		}
		registerApiProvider(
			{
				api: "pool",
				stream: (model, context, options) => this.stream(model, context, options as SimpleStreamOptions),
				streamSimple: (model, context, options) => this.stream(model, context, options),
			},
			"provider:pool",
		);
		return { models: poolModels, errors };
	}

	getMembers(model: Model<Api>): Model<Api>[] {
		return model.provider === "pool" ? (this.members.get(model.id) ?? []) : [];
	}

	private stream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
		const output = createAssistantMessageEventStream();
		let activeModel = model;
		const abort = () => {
			output.push(createError(activeModel, "Request aborted", "aborted"));
			output.end();
		};
		if (options?.signal?.aborted) {
			abort();
			return output;
		}
		options?.signal?.addEventListener("abort", abort, { once: true });
		void (async () => {
			let lastError: ErrorEvent | undefined;
			try {
				for (const member of this.getMembers(model)) {
					if (options?.signal?.aborted) return;
					const key = `${member.provider}/${member.id}`;
					if ((this.exhaustedUntil.get(key) ?? 0) > this.now()) continue;
					if (!this.registry.hasConfiguredAuth(member)) continue;
					const auth = await this.registry.getApiKeyAndHeaders(member);
					if (options?.signal?.aborted) return;
					if (!auth.ok) continue;
					activeModel = member;
					const error = await this.forwardMember(
						streamSimple(member, context, {
							...options,
							apiKey: auth.apiKey,
							headers: auth.headers,
							env: auth.env,
						}),
						output,
						options?.signal,
					);
					if (options?.signal?.aborted) return;
					if (!error) return;
					lastError = error;
					this.exhaustedUntil.set(key, this.now() + POOL_EXHAUSTION_COOLDOWN_MS);
				}
				output.push(lastError ?? createError(model, `Pool "${model.id}": no eligible members available.`));
			} catch (error) {
				output.push(createError(activeModel, error instanceof Error ? error.message : String(error)));
			} finally {
				options?.signal?.removeEventListener("abort", abort);
				output.end();
			}
		})();
		return output;
	}

	/** Only a quota error as the first non-start event can select another member. */
	private async forwardMember(
		input: AssistantMessageEventStream,
		output: AssistantMessageEventStream,
		signal?: AbortSignal,
	): Promise<ErrorEvent | undefined> {
		const buffered: AssistantMessageEvent[] = [];
		let forwarding = false;
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
		}
		return undefined;
	}
}
