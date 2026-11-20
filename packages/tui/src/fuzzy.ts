/**
 * Fuzzy matching utilities.
 * Matches if all query characters appear in order (not necessarily consecutive).
 * Lower score = better match.
 */

export interface FuzzyMatch {
	matches: boolean;
	score: number;
}

/** Lowercases for comparison; Greek final sigma folds to σ, since lowercasing picks ς only at the end of a word. */
function foldCase(value: string): string {
	return value.toLowerCase().replace(/ς/g, "σ");
}

function scorePositions(text: string, positions: readonly number[]): number {
	let score = 0;
	let lastMatchIndex = -1;
	let consecutiveMatches = 0;

	for (const i of positions) {
		if (lastMatchIndex === i - 1) {
			consecutiveMatches++;
			score -= consecutiveMatches * 5;
		} else {
			consecutiveMatches = 0;
			if (lastMatchIndex >= 0) score += (i - lastMatchIndex - 1) * 2;
		}
		const prevChar = text[i - 1];
		if (prevChar === undefined || /[\s\-_./:]/.test(prevChar)) score -= 10;
		score += i * 0.1;
		lastMatchIndex = i;
	}
	return score;
}

function matchQuery(query: string, text: string): FuzzyMatch {
	if (query.length === 0) return { matches: true, score: 0 };
	if (query.length > text.length) return { matches: false, score: 0 };

	// Score the greedy alignment and every contiguous occurrence of the query.
	const positions: number[] = [];
	let lastMatchIndex = -1;
	for (const character of query.split("")) {
		lastMatchIndex = text.indexOf(character, lastMatchIndex + 1);
		if (lastMatchIndex === -1) return { matches: false, score: 0 };
		positions.push(lastMatchIndex);
	}
	let score = scorePositions(text, positions);
	for (let start = text.indexOf(query); start !== -1; start = text.indexOf(query, start + 1)) {
		for (let i = 0; i < positions.length; i++) positions[i] = start + i;
		score = Math.min(score, scorePositions(text, positions));
	}
	return { matches: true, score: query === text ? score - 100 : score };
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	const queryLower = foldCase(query);
	const textLower = foldCase(text);
	const primaryMatch = matchQuery(queryLower, textLower);
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

	const swappedMatch = matchQuery(swappedQuery, textLower);
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
