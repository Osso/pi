/**
 * Fuzzy matching utilities.
 * Matches if all query characters appear in order (not necessarily consecutive).
 * Lower score = better match.
 */

export interface FuzzyMatch {
	matches: boolean;
	score: number;
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	const queryLower = query.toLowerCase();
	const textLower = text.toLowerCase();

	const matchQuery = (normalizedQuery: string): FuzzyMatch => {
		if (normalizedQuery.length === 0) {
			return { matches: true, score: 0 };
		}

		if (normalizedQuery.length > textLower.length) {
			return { matches: false, score: 0 };
		}

		let queryIndex = 0;
		let score = 0;
		let lastMatchIndex = -1;
		let consecutiveMatches = 0;

		for (let i = 0; i < textLower.length && queryIndex < normalizedQuery.length; i++) {
			if (textLower[i] === normalizedQuery[queryIndex]) {
				const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1]!);

				// Reward consecutive matches
				if (lastMatchIndex === i - 1) {
					consecutiveMatches++;
					score -= consecutiveMatches * 5;
				} else {
					consecutiveMatches = 0;
					// Penalize gaps
					if (lastMatchIndex >= 0) {
						score += (i - lastMatchIndex - 1) * 2;
					}
				}

				// Reward word boundary matches
				if (isWordBoundary) {
					score -= 10;
				}

				// Slight penalty for later matches
				score += i * 0.1;

				lastMatchIndex = i;
				queryIndex++;
			}
		}

		if (queryIndex < normalizedQuery.length) {
			return { matches: false, score: 0 };
		}

		if (normalizedQuery === textLower) {
			score -= 100;
		}

		return { matches: true, score };
	};

	const primaryMatch = matchQuery(queryLower);
	if (primaryMatch.matches) {
		return primaryMatch;
	}

	const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
	const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
	const swappedQuery = alphaNumericMatch
		? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
		: numericAlphaMatch
			? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
			: "";

	if (!swappedQuery) {
		return primaryMatch;
	}

	const swappedMatch = matchQuery(swappedQuery);
	if (!swappedMatch.matches) {
		return primaryMatch;
	}

	return { matches: true, score: swappedMatch.score + 5 };
}

/**
 * Best (lowest) score a token achieves against any one candidate string.
 * A token matches the item if it matches at least one candidate; the score of
 * the winning candidate is used. Matching each candidate independently prevents
 * a single query character from being satisfied across two unrelated fields
 * (e.g. "gpt-5.5" finding its second "5" in a repeated copy of "gpt-5.4").
 */
function bestTokenMatch(token: string, candidates: string[]): FuzzyMatch {
	let best: FuzzyMatch = { matches: false, score: 0 };
	for (const candidate of candidates) {
		const match = fuzzyMatch(token, candidate);
		if (match.matches && (!best.matches || match.score < best.score)) {
			best = match;
		}
	}
	return best;
}

/**
 * Filter and sort items by fuzzy match quality (best matches first).
 * Supports whitespace- and slash-separated tokens: all tokens must match.
 *
 * `getText` may return a single string or an array of candidate strings. When
 * it returns multiple candidates, each token is scored against every candidate
 * independently and the best-scoring candidate wins — candidates are never
 * concatenated, so a token cannot match by spanning two of them.
 */
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string | string[]): T[] {
	if (!query.trim()) {
		return items;
	}

	const tokens = query
		.trim()
		.split(/[\s/]+/)
		.filter((t) => t.length > 0);

	if (tokens.length === 0) {
		return items;
	}

	const results: { item: T; totalScore: number }[] = [];

	for (const item of items) {
		const text = getText(item);
		const candidates = Array.isArray(text) ? text : [text];
		let totalScore = 0;
		let allMatch = true;

		for (const token of tokens) {
			const match = bestTokenMatch(token, candidates);
			if (match.matches) {
				totalScore += match.score;
			} else {
				allMatch = false;
				break;
			}
		}

		if (allMatch) {
			results.push({ item, totalScore });
		}
	}

	results.sort((a, b) => a.totalScore - b.totalScore);
	return results.map((r) => r.item);
}
