import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "child_process";
import { type Static, type TSchema, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const codeIndexSymbolKindSchema = Type.Union([
	Type.Literal("function"),
	Type.Literal("method"),
	Type.Literal("class"),
	Type.Literal("trait"),
	Type.Literal("interface"),
	Type.Literal("struct"),
	Type.Literal("enum"),
	Type.Literal("property"),
	Type.Literal("event"),
]);

const codeIndexReferenceKindSchema = Type.Union([
	Type.Literal("call"),
	Type.Literal("inherit"),
	Type.Literal("implement"),
	Type.Literal("import"),
	Type.Literal("trait_impl"),
]);

const outlineSchema = Type.Object({
	path: Type.String({ description: "File or directory to outline" }),
	digest: Type.Optional(Type.Boolean({ description: "Show compact directory digest (default: false)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '**/*.ts'" })),
	show: Type.Optional(Type.String({ description: "Show one symbol body or section from the outline" })),
});

const symbolSchema = Type.Object({
	name: Type.String({ description: "Symbol name to find" }),
	kind: Type.Optional(codeIndexSymbolKindSchema),
	file: Type.Optional(Type.String({ description: "Filter by file path substring" })),
});

const referencesSchema = Type.Object({
	name: Type.String({ description: "Symbol name to find references for" }),
	kind: Type.Optional(codeIndexReferenceKindSchema),
});

export type OutlineToolInput = Static<typeof outlineSchema>;
export type SymbolToolInput = Static<typeof symbolSchema>;
export type ReferencesToolInput = Static<typeof referencesSchema>;

export interface CodeIndexToolDetails {
	truncation?: TruncationResult;
}

export interface CodeIndexCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

export interface CodeIndexOperations {
	/** Run the external code-index CLI with argv-style arguments. */
	run: (args: string[], cwd: string, signal?: AbortSignal) => Promise<CodeIndexCommandResult>;
}

export interface CodeIndexToolOptions {
	/** Custom command runner. Default: local code-index CLI. */
	operations?: CodeIndexOperations;
}

const defaultCodeIndexOperations: CodeIndexOperations = {
	run: (args, cwd, signal) => runCodeIndexCommand("code-index", args, cwd, signal),
};

function runCodeIndexCommand(
	codeIndexPath: string,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<CodeIndexCommandResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}

		let settled = false;
		let stdout = "";
		let stderr = "";
		const child = spawn(codeIndexPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const onAbort = () => {
			if (!child.killed) child.kill();
			settle(() => reject(new Error("Operation aborted")));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			settle(() => reject(new Error(`Failed to run code-index: ${error.message}`)));
		});
		child.on("close", (exitCode) => {
			settle(() => resolve({ stdout, stderr, exitCode }));
		});
	});
}

function formatCodeIndexCall(toolName: string, target: string | null, theme: Theme, suffix?: string): string {
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold(toolName)) +
		" " +
		(target === null ? invalidArg : theme.fg("accent", shortenPath(target || "")));
	if (suffix) text += theme.fg("toolOutput", ` ${suffix}`);
	return text;
}

function formatCodeIndexResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: CodeIndexToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		text += `\n${theme.fg("warning", `[Truncated: ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
	}
	return text;
}

async function executeCodeIndex(
	ops: CodeIndexOperations,
	cwd: string,
	args: string[],
	signal?: AbortSignal,
): Promise<{ content: [{ type: "text"; text: string }]; details: CodeIndexToolDetails | undefined }> {
	const result = await ops.run(args, cwd, signal);
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
	if (result.exitCode !== 0) {
		const message = result.stderr.trim() || result.stdout.trim() || `code-index exited with code ${result.exitCode}`;
		throw new Error(message);
	}

	const rawOutput = result.stdout.trimEnd();
	const output = rawOutput.length > 0 ? rawOutput : "No results found";
	const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
	let text = truncation.content;
	const details: CodeIndexToolDetails = {};
	if (truncation.truncated) {
		text += `\n\n[${formatSize(DEFAULT_MAX_BYTES)} limit reached]`;
		details.truncation = truncation;
	}

	return {
		content: [{ type: "text", text }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

function createCodeIndexToolDefinition<TParams extends TSchema>(
	config: {
		name: string;
		label: string;
		description: string;
		promptSnippet: string;
		parameters: TParams;
		buildArgs: (params: Static<TParams>) => string[];
		renderTarget: (args: Static<TParams> | undefined) => string | null;
		renderSuffix?: (args: Static<TParams> | undefined) => string | undefined;
	},
	cwd: string,
	options?: CodeIndexToolOptions,
): ToolDefinition<TParams, CodeIndexToolDetails | undefined> {
	const ops = options?.operations ?? defaultCodeIndexOperations;
	return {
		name: config.name,
		label: config.label,
		description: config.description,
		promptSnippet: config.promptSnippet,
		parameters: config.parameters,
		async execute(_toolCallId, params, signal) {
			return executeCodeIndex(ops, cwd, config.buildArgs(params), signal);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const target = config.renderTarget(args);
			const suffix = config.renderSuffix?.(args);
			text.setText(formatCodeIndexCall(config.name, target, theme, suffix));
			return text;
		},
		renderResult(result, renderOptions, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatCodeIndexResult(result, renderOptions, theme, context.showImages));
			return text;
		},
	};
}

export function createOutlineToolDefinition(
	cwd: string,
	options?: CodeIndexToolOptions,
): ToolDefinition<typeof outlineSchema, CodeIndexToolDetails | undefined> {
	return createCodeIndexToolDefinition(
		{
			name: "outline",
			label: "outline",
			description:
				"Show a structural outline for a file or directory using the external code-index CLI. Output is truncated to 10KB.",
			promptSnippet: "Show structural outlines for files or directories",
			parameters: outlineSchema,
			buildArgs: ({ path, digest, glob, show }) => {
				const args = ["outline", path];
				if (digest) args.push("--digest");
				if (glob) args.push("--glob", glob);
				if (show) args.push("--show", show);
				return args;
			},
			renderTarget: (args) => str(args?.path),
			renderSuffix: (args) => {
				const parts: string[] = [];
				if (args?.digest) parts.push("digest");
				if (args?.glob) parts.push(args.glob);
				if (args?.show) parts.push(`show ${args.show}`);
				return parts.length > 0 ? `(${parts.join(", ")})` : undefined;
			},
		},
		cwd,
		options,
	);
}

export function createSymbolToolDefinition(
	cwd: string,
	options?: CodeIndexToolOptions,
): ToolDefinition<typeof symbolSchema, CodeIndexToolDetails | undefined> {
	return createCodeIndexToolDefinition(
		{
			name: "symbol",
			label: "symbol",
			description: "Find symbol definitions by name using the external code-index CLI. Output is truncated to 10KB.",
			promptSnippet: "Find symbol definitions by name",
			parameters: symbolSchema,
			buildArgs: ({ name, kind, file }) => {
				const args = ["symbol", name];
				if (kind) args.push("--kind", kind);
				if (file) args.push("--file", file);
				return args;
			},
			renderTarget: (args) => str(args?.name),
			renderSuffix: (args) => {
				const parts: string[] = [];
				if (args?.kind) parts.push(args.kind);
				if (args?.file) parts.push(`in ${shortenPath(args.file)}`);
				return parts.length > 0 ? `(${parts.join(", ")})` : undefined;
			},
		},
		cwd,
		options,
	);
}

export function createReferencesToolDefinition(
	cwd: string,
	options?: CodeIndexToolOptions,
): ToolDefinition<typeof referencesSchema, CodeIndexToolDetails | undefined> {
	return createCodeIndexToolDefinition(
		{
			name: "references",
			label: "references",
			description:
				"Find structural references to a symbol using the external code-index CLI. Output is truncated to 10KB.",
			promptSnippet: "Find structural references to a symbol",
			parameters: referencesSchema,
			buildArgs: ({ name, kind }) => {
				const args = ["references", name];
				if (kind) args.push("--kind", kind);
				return args;
			},
			renderTarget: (args) => str(args?.name),
			renderSuffix: (args) => (args?.kind ? `(${args.kind})` : undefined),
		},
		cwd,
		options,
	);
}

export function createOutlineTool(cwd: string, options?: CodeIndexToolOptions): AgentTool<typeof outlineSchema> {
	return wrapToolDefinition(createOutlineToolDefinition(cwd, options));
}

export function createSymbolTool(cwd: string, options?: CodeIndexToolOptions): AgentTool<typeof symbolSchema> {
	return wrapToolDefinition(createSymbolToolDefinition(cwd, options));
}

export function createReferencesTool(cwd: string, options?: CodeIndexToolOptions): AgentTool<typeof referencesSchema> {
	return wrapToolDefinition(createReferencesToolDefinition(cwd, options));
}
