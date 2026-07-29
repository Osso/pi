import { type Api, type Context, type ImageContent, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../../../src/core/extensions/types.ts";

interface ImageGenerationTool {
	type: "image_generation";
}

interface PayloadWithTools extends Record<string, unknown> {
	tools?: unknown[];
}

interface ImageGenerationRequest {
	prompt: string;
	model: OpenAIImageGenerationModel;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	signal?: AbortSignal;
}

type OpenAIImageGenerationApi = "openai-responses" | "openai-codex-responses";
type OpenAIImageGenerationModel = Model<OpenAIImageGenerationApi>;
type RunImageGeneration = (request: ImageGenerationRequest, ctx: ExtensionContext) => Promise<ImageContent>;

const DEFAULT_IMAGE_GENERATION_TIMEOUT_MS = 300_000;

const imageGenerationSchema = Type.Object({
	prompt: Type.String({ description: "Detailed description of the image to generate." }),
});

type ImageGenerationInput = Static<typeof imageGenerationSchema>;

export default function codexImageGenerationExtension(pi: ExtensionAPI) {
	pi.registerTool(createImageGenerationToolDefinition());
}

export function createImageGenerationToolDefinition(options?: {
	runGeneration?: RunImageGeneration;
	timeoutMs?: number;
}): ToolDefinition<typeof imageGenerationSchema> {
	const runGeneration = options?.runGeneration ?? runHostedImageGeneration;
	const timeoutMs = options?.timeoutMs ?? DEFAULT_IMAGE_GENERATION_TIMEOUT_MS;
	return {
		name: "image_gen",
		label: "Image Generation",
		description: "Generate an image using the OpenAI Responses hosted image generation tool.",
		promptSnippet: "Generate an image from a detailed prompt.",
		promptGuidelines: [
			"Use image_gen when the user asks to create a new image.",
			"Describe composition, subject, style, lighting, palette, and constraints in the prompt.",
		],
		approvalRequired: true,
		parameters: imageGenerationSchema,
		async execute(_toolCallId, params: ImageGenerationInput, signal, _onUpdate, ctx): Promise<AgentToolResult<undefined>> {
			const image = await executeImageGeneration(params, ctx, signal, runGeneration, timeoutMs);
			return { content: [image], details: undefined };
		},
	};
}

export function isOpenAIHostedImageGenerationModel(
	model: Model<Api> | undefined,
): model is OpenAIImageGenerationModel {
	return model?.api === "openai-responses" || model?.api === "openai-codex-responses";
}

async function executeImageGeneration(
	params: ImageGenerationInput,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	runGeneration: RunImageGeneration,
	timeoutMs: number,
): Promise<ImageContent> {
	const prompt = params.prompt.trim();
	if (!prompt) throw new Error("image_gen prompt is required");
	if (!isOpenAIHostedImageGenerationModel(ctx.model)) {
		throw new Error("image_gen requires an OpenAI Responses model");
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) throw new Error(auth.error);

	const timeoutController = new AbortController();
	const timeout = setTimeout(() => {
		timeoutController.abort(new Error(`OpenAI hosted image generation timed out after ${formatTimeout(timeoutMs)}`));
	}, timeoutMs);
	timeout.unref?.();
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;

	try {
		return await runGeneration(
			{
				prompt,
				model: ctx.model,
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal: combinedSignal,
			},
			ctx,
		);
	} finally {
		clearTimeout(timeout);
	}
}

async function runHostedImageGeneration(request: ImageGenerationRequest): Promise<ImageContent> {
	const context: Context = {
		systemPrompt: "Generate the requested image. Use the hosted image generation tool and return the generated image.",
		messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
	};
	const stream = streamSimple(request.model, context, {
		apiKey: request.apiKey,
		headers: request.headers,
		env: request.env,
		signal: request.signal,
		onPayload: (payload) => addImageGenerationToolToPayload(payload),
	});
	const message = await stream.result();
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new Error(message.errorMessage ?? "OpenAI hosted image generation failed");
	}
	return extractImage(message);
}

export function addImageGenerationToolToPayload(payload: unknown): unknown | undefined {
	if (!isRecord(payload)) return undefined;

	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	const toolsWithoutFunctionImageGeneration = tools.filter((tool) => !isFunctionImageGenerationTool(tool));
	if (toolsWithoutFunctionImageGeneration.some(isHostedImageGenerationTool)) {
		return toolsWithoutFunctionImageGeneration.length === tools.length
			? undefined
			: ({ ...payload, tools: toolsWithoutFunctionImageGeneration } satisfies PayloadWithTools);
	}

	return {
		...payload,
		tools: [...toolsWithoutFunctionImageGeneration, createImageGenerationTool()],
	} satisfies PayloadWithTools;
}

function createImageGenerationTool(): ImageGenerationTool {
	return { type: "image_generation" };
}

function isHostedImageGenerationTool(value: unknown): boolean {
	return isRecord(value) && value.type === "image_generation";
}

function isFunctionImageGenerationTool(value: unknown): boolean {
	return isRecord(value) && value.type === "function" && value.name === "image_gen";
}

function isRecord(value: unknown): value is PayloadWithTools {
	return typeof value === "object" && value !== null;
}

function extractImage(message: AssistantMessage): ImageContent {
	if (!message.imageGenerationResult) {
		throw new Error("OpenAI hosted image generation returned no image");
	}
	return message.imageGenerationResult;
}

function formatTimeout(timeoutMs: number): string {
	return timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
}
