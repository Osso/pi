import type {
	Agent,
	AgentContext,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import { validateToolArguments } from "@earendil-works/pi-ai/compat";
import { STANDALONE_DISABLED_TOOL_NAMES } from "./tool-capabilities.ts";

interface ProgrammaticToolCallInput {
	toolName: string;
	params: unknown;
	signal: AbortSignal | undefined;
	activeToolCallId?: string;
	noSupervisor: boolean;
	activeTools: AgentTool[];
	activeToolNames: string[];
	toolRegistry: Map<string, AgentTool>;
	systemPrompt: string;
	messages: AgentMessage[];
	model: Model<Api> | undefined;
	toolHooks: Pick<Agent, "beforeToolCall" | "afterToolCall">;
}

export async function callActiveTool(input: ProgrammaticToolCallInput): Promise<AgentToolResult<unknown>> {
	const {
		toolName,
		params,
		signal,
		activeToolCallId,
		noSupervisor,
		activeTools,
		activeToolNames,
		toolRegistry,
		toolHooks,
	} = input;
	if (noSupervisor && STANDALONE_DISABLED_TOOL_NAMES.has(toolName))
		throw new Error(`Tool ${toolName} is unavailable in standalone worker mode`);
	if (!activeToolNames.includes(toolName)) {
		throw new Error(`Tool is not active: ${toolName}`);
	}
	if (toolName === "pyrun_eval") {
		throw new Error("pyrun_eval cannot call itself through pi.tools.call");
	}
	const tool = toolRegistry.get(toolName);
	if (!tool) {
		throw new Error(`Tool is not registered: ${toolName}`);
	}

	const toolCallId = activeToolCallId ?? `pyrun:${toolName}:${Date.now()}`;
	let toolCall = createSyntheticToolCall(toolName, toolCallId, params);
	if (tool.prepareArguments) {
		toolCall = createSyntheticToolCall(toolName, toolCallId, tool.prepareArguments(toolCall.arguments));
	}
	const validatedArgs = validateToolArguments(tool, toolCall) as unknown;
	const context = createSyntheticToolCallContext(input.systemPrompt, input.messages, activeTools);
	const assistantMessage = createSyntheticToolCallAssistantMessage(toolCall, input.model);
	const beforeResult = await toolHooks.beforeToolCall?.(
		{ assistantMessage, args: validatedArgs, context, toolCall },
		signal,
	);
	if (beforeResult?.block) {
		return createErrorToolResult(beforeResult.reason ?? "Tool execution was blocked");
	}
	// A tool_call handler can abort the turn; like the model tool path, the tool must not run then.
	if (signal?.aborted) return createErrorToolResult("Operation aborted");

	let result: AgentToolResult<unknown>;
	let isError = false;
	try {
		result = await tool.execute(toolCallId, validatedArgs as never, signal);
		isError = result.isError ?? false;
	} catch (error) {
		result = createErrorToolResult(error instanceof Error ? error.message : String(error));
		isError = true;
	}

	const afterResult = await toolHooks.afterToolCall?.(
		{ assistantMessage, args: validatedArgs, context, isError, result, toolCall },
		signal,
	);
	return afterResult ? { ...result, ...afterResult } : result;
}

function createErrorToolResult(message: string): AgentToolResult<undefined> {
	return {
		content: [{ type: "text", text: message }],
		details: undefined,
		isError: true,
	};
}

function createSyntheticToolCall(toolName: string, toolCallId: string, params: unknown): AgentToolCall {
	const toolArguments = params && typeof params === "object" ? (params as Record<string, unknown>) : { value: params };
	return {
		type: "toolCall",
		id: toolCallId,
		name: toolName,
		arguments: toolArguments,
	};
}

function createSyntheticToolCallAssistantMessage(
	toolCall: AgentToolCall,
	model: Model<Api> | undefined,
): AssistantMessage {
	return {
		role: "assistant",
		content: [toolCall],
		api: model?.api ?? "openai-completions",
		provider: model?.provider ?? "pyrun",
		model: model?.id ?? "pyrun-tools-call",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createSyntheticToolCallContext(
	systemPrompt: string,
	messages: AgentMessage[],
	tools: AgentTool[],
): AgentContext {
	return { systemPrompt, messages, tools };
}
