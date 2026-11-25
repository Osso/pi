import type { Api, Model } from "@earendil-works/pi-ai";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import type { ModelRegistry } from "../../core/model-registry.ts";

export function listSelectableModels(
	modelRegistry: ModelRegistry,
	scopedModels: ReadonlyArray<{ model: Model<Api> }>,
): Model<Api>[] {
	if (scopedModels.length === 0) return modelRegistry.getAvailable();
	return scopedModels.flatMap(({ model }) => {
		const { provider, id } = model;
		const refreshed = modelRegistry.find(provider, id);
		if (!refreshed || modelRegistry.isModelDisabled(provider, id)) return [];
		return [refreshed];
	});
}

export interface ModelSearchItem {
	id: string;
	provider: string;
	name?: string;
}

/**
 * Candidate strings a model is fuzzy-matched against. Each candidate is matched
 * independently (see `fuzzyFilter`), so query characters can never be satisfied
 * by spanning two candidates or a duplicated copy of one — that is what let a
 * query like "gpt-5.5" wrongly match "gpt-5.4" when the search text repeated the
 * model id. Distinct candidates instead let a token match the bare id, the
 * provider-qualified id, the provider+id pair (for order-independent fragment
 * queries like "codexgpt"), or the display name — whichever scores best.
 *
 * Provider-prefixed queries still rank exact providers before proxy-provider ids
 * (e.g. openai/gpt-5 before openrouter/openai/gpt-5) because a query token that
 * equals the bare id earns the exact-match scoring bonus.
 */
export function getModelSearchCandidates(item: ModelSearchItem): string[] {
	const { id, provider, name } = item;
	const candidates = [id, `${provider}/${id}`, `${provider} ${id}`];
	if (name) {
		candidates.push(name);
	}
	return candidates;
}

/**
 * Fuzzy-filters models by their search candidates. An exact `provider/id` query names one model, so it
 * ranks first: fuzzy scores tie for providers sharing a prefix (openai and openai-codex).
 */
export function searchModels<T>(items: T[], query: string, toSearchItem: (item: T) => ModelSearchItem): T[] {
	const matches = fuzzyFilter(items, query, (item) => getModelSearchCandidates(toSearchItem(item)));
	const reference = query.trim().toLowerCase();
	const exactIndex = matches.findIndex((item) => {
		const { provider, id } = toSearchItem(item);
		return `${provider}/${id}`.toLowerCase() === reference;
	});
	if (exactIndex <= 0) return matches;
	const [exact] = matches.splice(exactIndex, 1);
	return exact === undefined ? matches : [exact, ...matches];
}
