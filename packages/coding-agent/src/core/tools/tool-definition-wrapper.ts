import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { formatSize, type TruncationResult, truncateTail } from "./truncate.ts";

interface ToolOutputDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

function createFullOutputPath(): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `pi-tool-${id}.log`);
}

function mergeOutputDetails<TDetails>(details: TDetails | undefined, outputDetails: ToolOutputDetails): TDetails {
	if (details !== null && typeof details === "object") {
		return { ...details, ...outputDetails } as TDetails;
	}
	return outputDetails as TDetails;
}

function hasExistingOutputDetails(details: unknown): boolean {
	if (details === null || typeof details !== "object") {
		return false;
	}

	const hasFullOutputPath = "fullOutputPath" in details;
	const hasTruncation = "truncation" in details;
	return hasFullOutputPath || hasTruncation;
}

function capToolResultOutput<TDetails>(result: AgentToolResult<TDetails>): AgentToolResult<TDetails> {
	if (hasExistingOutputDetails(result.details)) {
		return result;
	}

	const textContent = result.content.filter((entry): entry is { type: "text"; text: string } => {
		return entry.type === "text" && typeof entry.text === "string";
	});
	const fullText = textContent.map((entry) => entry.text).join("\n");
	const truncation = truncateTail(fullText);
	if (!truncation.truncated) {
		return result;
	}

	const fullOutputPath = createFullOutputPath();
	writeFileSync(fullOutputPath, fullText, "utf-8");
	const footer = `[Showing last ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}. Full output: ${fullOutputPath}]`;
	return {
		...result,
		content: [{ type: "text" as const, text: `${truncation.content}\n\n${footer}` }],
		details: mergeOutputDetails(result.details, { truncation, fullOutputPath }),
	};
}

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TParams extends TSchema, TDetails = unknown>(
	definition: ToolDefinition<TParams, TDetails>,
	ctxFactory?: () => ExtensionContext,
): AgentTool<TParams, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const cappedUpdate = onUpdate
				? (partial: AgentToolResult<TDetails>) => onUpdate(capToolResultOutput(partial))
				: undefined;
			const context = ctxFactory?.() as ExtensionContext;
			const result = await definition.execute(toolCallId, params, signal, cappedUpdate, context);
			return capToolResultOutput(result);
		},
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions<TParams extends TSchema, TDetails = unknown>(
	definitions: ToolDefinition<TParams, TDetails>[],
	ctxFactory?: () => ExtensionContext,
): AgentTool<TParams, TDetails>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool<TParams extends TSchema>(
	tool: AgentTool<TParams>,
): ToolDefinition<TParams, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
