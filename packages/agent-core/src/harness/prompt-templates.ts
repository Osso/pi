import type { ExecutionEnv, FileInfo, PromptTemplate } from "./types.ts";
import { parseFrontmatter } from "./utils/frontmatter.ts";

export type PromptTemplateDiagnosticCode = "file_info_failed" | "list_failed" | "read_failed" | "parse_failed";

/** Warning produced while loading prompt templates. */
export interface PromptTemplateDiagnostic {
	/** Diagnostic severity. Currently only warnings are emitted. */
	type: "warning";
	/** Stable diagnostic code. */
	code: PromptTemplateDiagnosticCode;
	/** Human-readable diagnostic message. */
	message: string;
	/** Path associated with the diagnostic. */
	path: string;
}

interface PromptTemplateFrontmatter {
	description?: string;
	"argument-hint"?: string;
	[key: string]: unknown;
}

/**
 * Load prompt templates from one or more paths.
 *
 * Directory inputs load direct `.md` children non-recursively. File inputs load explicit `.md` files. Missing paths and
 * non-markdown files are skipped. Read and parse failures are returned as diagnostics.
 */
export async function loadPromptTemplates(
	env: ExecutionEnv,
	paths: string | string[],
): Promise<{ promptTemplates: PromptTemplate[]; diagnostics: PromptTemplateDiagnostic[] }> {
	const promptTemplates: PromptTemplate[] = [];
	const diagnostics: PromptTemplateDiagnostic[] = [];
	for (const path of Array.isArray(paths) ? paths : [paths]) {
		const infoResult = await env.fileInfo(path);
		if (!infoResult.ok) {
			if (infoResult.error.code !== "not_found") {
				diagnostics.push({
					type: "warning",
					code: "file_info_failed",
					message: infoResult.error.message,
					path,
				});
			}
			continue;
		}
		const info = infoResult.value;
		const kind = await resolveKind(env, info, diagnostics);
		if (kind === "directory") {
			const result = await loadTemplatesFromDir(env, info.path);
			promptTemplates.push(...result.promptTemplates);
			diagnostics.push(...result.diagnostics);
		} else if (kind === "file" && info.name.endsWith(".md")) {
			const result = await loadTemplateFromFile(env, info.path);
			if (result.promptTemplate) promptTemplates.push(result.promptTemplate);
			diagnostics.push(...result.diagnostics);
		}
	}
	return { promptTemplates, diagnostics };
}

/**
 * Load prompt templates from source-tagged paths.
 *
 * Source values are preserved exactly and attached to every loaded prompt template and diagnostic. The agent package does
 * not interpret source values; applications define their own provenance shape.
 */
export async function loadSourcedPromptTemplates<TSource, TPromptTemplate extends PromptTemplate = PromptTemplate>(
	env: ExecutionEnv,
	inputs: Array<{ path: string; source: TSource }>,
	mapPromptTemplate?: (promptTemplate: PromptTemplate, source: TSource) => TPromptTemplate,
): Promise<{
	promptTemplates: Array<{ promptTemplate: TPromptTemplate; source: TSource }>;
	diagnostics: Array<PromptTemplateDiagnostic & { source: TSource }>;
}> {
	const promptTemplates: Array<{ promptTemplate: TPromptTemplate; source: TSource }> = [];
	const diagnostics: Array<PromptTemplateDiagnostic & { source: TSource }> = [];
	for (const input of inputs) {
		const result = await loadPromptTemplates(env, input.path);
		for (const promptTemplate of result.promptTemplates) {
			promptTemplates.push({
				promptTemplate: mapPromptTemplate
					? mapPromptTemplate(promptTemplate, input.source)
					: (promptTemplate as TPromptTemplate),
				source: input.source,
			});
		}
		for (const diagnostic of result.diagnostics) diagnostics.push({ ...diagnostic, source: input.source });
	}
	return { promptTemplates, diagnostics };
}

async function loadTemplatesFromDir(
	env: ExecutionEnv,
	dir: string,
): Promise<{ promptTemplates: PromptTemplate[]; diagnostics: PromptTemplateDiagnostic[] }> {
	const promptTemplates: PromptTemplate[] = [];
	const diagnostics: PromptTemplateDiagnostic[] = [];
	const entriesResult = await env.listDir(dir);
	if (!entriesResult.ok) {
		diagnostics.push({
			type: "warning",
			code: "list_failed",
			message: entriesResult.error.message,
			path: dir,
		});
		return { promptTemplates, diagnostics };
	}
	const entries = entriesResult.value;

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const kind = await resolveKind(env, entry, diagnostics);
		if (kind !== "file" || !entry.name.endsWith(".md")) continue;
		const result = await loadTemplateFromFile(env, entry.path);
		if (result.promptTemplate) promptTemplates.push(result.promptTemplate);
		diagnostics.push(...result.diagnostics);
	}
	return { promptTemplates, diagnostics };
}

async function loadTemplateFromFile(
	env: ExecutionEnv,
	filePath: string,
): Promise<{ promptTemplate: PromptTemplate | null; diagnostics: PromptTemplateDiagnostic[] }> {
	const diagnostics: PromptTemplateDiagnostic[] = [];
	const rawContent = await env.readTextFile(filePath);
	if (!rawContent.ok) {
		diagnostics.push({
			type: "warning",
			code: "read_failed",
			message: rawContent.error.message,
			path: filePath,
		});
		return { promptTemplate: null, diagnostics };
	}

	const parsed = parseFrontmatter<PromptTemplateFrontmatter>(rawContent.value);
	if (!parsed.ok) {
		diagnostics.push({
			type: "warning",
			code: "parse_failed",
			message: parsed.error.message,
			path: filePath,
		});
		return { promptTemplate: null, diagnostics };
	}

	const { frontmatter, body } = parsed.value;
	const firstLine = body.split("\n").find((line) => line.trim());
	let description = typeof frontmatter.description === "string" ? frontmatter.description : "";
	if (!description && firstLine) {
		description = firstLine.slice(0, 60);
		if (firstLine.length > 60) description += "...";
	}
	return {
		promptTemplate: {
			name: basenameEnvPath(filePath).replace(/\.md$/i, ""),
			description,
			content: body,
		},
		diagnostics,
	};
}

async function resolveKind(
	env: ExecutionEnv,
	info: FileInfo,
	diagnostics: PromptTemplateDiagnostic[],
): Promise<"file" | "directory" | undefined> {
	if (info.kind === "file" || info.kind === "directory") return info.kind;
	const canonicalPath = await env.canonicalPath(info.path);
	if (!canonicalPath.ok) {
		if (canonicalPath.error.code !== "not_found") {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: canonicalPath.error.message,
				path: info.path,
			});
		}
		return undefined;
	}
	const target = await env.fileInfo(canonicalPath.value);
	if (!target.ok) {
		if (target.error.code !== "not_found") {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: target.error.message,
				path: info.path,
			});
		}
		return undefined;
	}
	return target.value.kind === "file" || target.value.kind === "directory" ? target.value.kind : undefined;
}

function basenameEnvPath(path: string): string {
	const normalized = path.replace(/\/+$/, "");
	const slashIndex = normalized.lastIndexOf("/");
	return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}

/** Parse an argument string using simple shell-style single and double quotes. */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	// A quoted empty string ("") is still an argument, as in bash.
	let inArg = false;
	let inQuote: string | null = null;
	// Where the open quote started, so an unclosed quote can be re-read as literal text
	let quoteStart = 0;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];
		if (inQuote) {
			if (char === "\\" && argsString[i + 1] === inQuote) {
				// A backslash before the open quote's character keeps it as text: "say \"hi\"" gives say "hi"
				current += inQuote;
				i++;
			} else if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if ((char === '"' || char === "'") && !inArg) {
			// Quotes only open at the start of an argument, so apostrophes inside words stay literal
			inQuote = char;
			quoteStart = i;
			inArg = true;
		} else if (char === " " || char === "\t") {
			if (inArg) {
				args.push(current);
				current = "";
				inArg = false;
			}
		} else {
			current += char;
			inArg = true;
		}
		if (inQuote && i === argsString.length - 1) {
			// Unclosed quote: keep the quote character as text and parse the rest normally
			// (current was empty when the quote opened, because quotes only open a new argument)
			inQuote = null;
			current = argsString[quoteStart] ?? "";
			i = quoteStart;
		}
	}
	if (inArg) args.push(current);
	return args;
}

/** Substitute prompt template placeholders (`$1`, `$@`, `$ARGUMENTS`, `${@:N}`, `${@:N:L}`) with command arguments. */
export function substituteArgs(content: string, args: string[]): string {
	// One pass over the template, so placeholders inside argument values stay literal.
	return content.replace(
		/\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(_, startStr?: string, lengthStr?: string, simple?: string) => {
			if (startStr) {
				const start = Math.max(0, parseInt(startStr, 10) - 1);
				if (lengthStr) return args.slice(start, start + parseInt(lengthStr, 10)).join(" ");
				return args.slice(start).join(" ");
			}
			if (simple === "ARGUMENTS" || simple === "@") return args.join(" ");
			return args[parseInt(simple ?? "", 10) - 1] ?? "";
		},
	);
}

/** Format a prompt template invocation with positional arguments. */
export function formatPromptTemplateInvocation(template: PromptTemplate, args: string[] = []): string {
	return substituteArgs(template.content, args);
}
