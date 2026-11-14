import { parse } from "yaml";
import { type Result, toError } from "../types.ts";

// Frontmatter needs whole `---` delimiter lines; `----` is a Markdown thematic break, not a delimiter.
const FRONTMATTER = /^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/;

export function parseFrontmatter<T extends Record<string, unknown>>(
	content: string,
): Result<{ frontmatter: T; body: string }, Error> {
	try {
		const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const match = FRONTMATTER.exec(normalized);
		if (!match) return { ok: true, value: { frontmatter: {} as T, body: normalized } };
		const body = normalized.slice(match[0].length).trim();
		return { ok: true, value: { frontmatter: (parse(match[1] ?? "") ?? {}) as T, body } };
	} catch (error) {
		return { ok: false, error: toError(error) };
	}
}
