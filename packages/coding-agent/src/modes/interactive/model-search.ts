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
