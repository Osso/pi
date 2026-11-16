import type { Token } from "marked";
import { isImageLine } from "../terminal-image.ts";
import { wrapTextWithAnsi } from "../wrap-ansi.ts";

export interface TokenRenderCache {
	nextTokenType?: string;
	width: number;
	fingerprint: string;
	wrappedLines: string[];
}

type RenderToken = (token: Token, width: number, nextTokenType?: string) => string[];

function renderAndWrapToken(renderToken: RenderToken, token: Token, width: number, nextTokenType?: string): string[] {
	return renderToken(token, width, nextTokenType).flatMap((line) =>
		isImageLine(line) ? [line] : wrapTextWithAnsi(line, width),
	);
}

/**
 * Render and wrap each top-level token, reusing the previous render's output for tokens whose
 * content, width, and following token type are unchanged (streaming re-renders mostly append).
 */
export function renderCachedTokens(
	tokens: Token[],
	width: number,
	previousCaches: TokenRenderCache[],
	renderToken: RenderToken,
): { wrappedLines: string[]; caches: TokenRenderCache[] } {
	const wrappedLines: string[] = [];
	const caches: TokenRenderCache[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token) throw new Error(`Missing markdown token at index ${i}`);
		const nextTokenType = tokens[i + 1]?.type;
		const fingerprint = JSON.stringify(token);
		const previous = previousCaches[i];
		const canReuse =
			previous?.width === width && previous.nextTokenType === nextTokenType && previous.fingerprint === fingerprint;
		const tokenLines = canReuse
			? previous.wrappedLines
			: renderAndWrapToken(renderToken, token, width, nextTokenType);
		caches.push({ nextTokenType, width, fingerprint, wrappedLines: tokenLines });
		for (const line of tokenLines) wrappedLines.push(line);
	}
	return { wrappedLines, caches };
}
