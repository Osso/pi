import { parse } from "yaml";

type ParsedFrontmatter<T extends Record<string, unknown>> = {
	frontmatter: T;
	body: string;
};

// Editors on Windows may save a UTF-8 BOM, which would hide the opening `---`.
const normalizeNewlines = (value: string): string =>
	value
		.replace(/^\uFEFF/, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");

// Frontmatter needs whole `---` delimiter lines; `----` is a Markdown thematic break, not a delimiter.
const FRONTMATTER = /^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/;

export const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> => {
	const normalized = normalizeNewlines(content);
	const match = FRONTMATTER.exec(normalized);
	if (!match) return { frontmatter: {} as T, body: normalized };

	const parsed: unknown = match[1] ? (parse(match[1]) ?? {}) : {};
	// A Markdown heading framed by rules can look like a YAML scalar, not a metadata mapping.
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		return { frontmatter: {} as T, body: normalized };
	}
	return { frontmatter: parsed as T, body: normalized.slice(match[0].length).trim() };
};

export const stripFrontmatter = (content: string): string => parseFrontmatter(content).body;
