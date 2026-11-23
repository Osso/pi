import { cjkBreakRegex } from "./utils.ts";

// CJK letters remain part of words and paths; only punctuation can separate prose from completions.
const cjkPunctuationRegex = new RegExp(
	`(?:(?=\\p{Punctuation})${cjkBreakRegex.source}|[，．：；！？（）［］｛｝“”‘’…—])`,
	"u",
);
export const autocompleteSeparatorRegex = new RegExp(`(?:\\s|${cjkPunctuationRegex.source})`, "u");
const tokenStartRegex = new RegExp(`(?:^|${autocompleteSeparatorRegex.source})$`, "u");
/** Where a token after the cursor ends: whitespace, CJK punctuation, or the end of the line. */
export const tokenEndRegex = new RegExp(`${autocompleteSeparatorRegex.source}|$`, "u");
const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);
// Opening wrappers that may precede a path in prose, mapped to their closing counterpart.
const PATH_WRAPPERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">", "`": "`" };

/** Index of the last path delimiter (ASCII delimiter, whitespace, or CJK punctuation), or -1. */
export function findLastDelimiter(text: string): number {
	let lastDelimiter = -1;
	let index = 0;
	for (const character of text) {
		index += character.length;
		if (PATH_DELIMITERS.has(character) || autocompleteSeparatorRegex.test(character)) lastDelimiter = index - 1;
	}
	return lastDelimiter;
}

/** Whether the text ends where a new token can start: empty, or after whitespace or CJK punctuation. */
export function endsAtTokenStart(text: string): boolean {
	return tokenStartRegex.test(text);
}

/** Whether a token can start at index, allowing opening wrappers such as "(" before it. */
export function isTokenStart(text: string, index: number): boolean {
	let start = index;
	while (start > 0 && PATH_WRAPPERS[text[start - 1] ?? ""]) start -= 1;
	return PATH_DELIMITERS.has(text[start - 1] ?? "") || endsAtTokenStart(text.slice(0, start));
}

// Strip opening wrappers before a path, e.g. "(~/Dev" -> "~/Dev" or "`src/ma" -> "src/ma".
// Keep a wrapper if the token also contains its closer, e.g. "app/[slug]/pa" or "(group)/pa".
export function stripLeadingWrappers(token: string): string {
	let result = token;
	for (;;) {
		const closer = PATH_WRAPPERS[result[0] ?? ""];
		if (!closer || result.includes(closer, 1)) return result;
		result = result.slice(1);
	}
}
