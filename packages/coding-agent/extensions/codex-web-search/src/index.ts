import type { Api, Model } from "@earendil-works/pi-ai";
import type { BeforeProviderRequestEvent, ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";

export type WebSearchMode = "disabled" | "cached" | "live";

type OpenAIWebSearchApi = "openai-responses" | "openai-codex-responses";
type OpenAIWebSearchModel = Model<OpenAIWebSearchApi>;

interface WebSearchTool {
	type: "web_search";
	external_web_access: boolean;
}

interface PayloadWithTools extends Record<string, unknown> {
	tools?: unknown[];
}

const WEB_SEARCH_FLAG = "web-search";

export default function codexWebSearchExtension(pi: ExtensionAPI) {
	pi.registerFlag(WEB_SEARCH_FLAG, {
		description: "Enable OpenAI Responses hosted web search: disabled, cached, or live",
		type: "string",
		default: "disabled",
	});

	pi.on("before_provider_request", (event, ctx) =>
		handleBeforeProviderRequest(event, ctx, pi.getFlag(WEB_SEARCH_FLAG)),
	);
}

export function handleBeforeProviderRequest(
	event: BeforeProviderRequestEvent,
	ctx: ExtensionContext,
	flagValue?: boolean | string,
): unknown | undefined {
	if (!isOpenAIHostedWebSearchModel(ctx.model)) return undefined;

	const mode = resolveWebSearchMode(flagValue);
	if (!mode) {
		ctx.ui.notify(`Invalid --${WEB_SEARCH_FLAG} value. Expected disabled, cached, or live.`, "warning");
		return undefined;
	}
	if (mode === "disabled") return undefined;

	return addWebSearchToolToPayload(event.payload, mode);
}

export function resolveWebSearchMode(value: boolean | string | undefined): WebSearchMode | undefined {
	if (value === undefined || value === false) return "disabled";
	if (value === true) return "live";

	const normalized = value.trim().toLowerCase();
	if (normalized === "" || normalized === "disabled" || normalized === "off" || normalized === "false") {
		return "disabled";
	}
	if (normalized === "cached" || normalized === "cache") return "cached";
	if (normalized === "live" || normalized === "true") return "live";
	return undefined;
}

export function addWebSearchToolToPayload(payload: unknown, mode: Exclude<WebSearchMode, "disabled">): unknown | undefined {
	if (!isRecord(payload)) return undefined;

	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	if (tools.some(isHostedWebSearchTool)) return undefined;

	return {
		...payload,
		tools: [...tools, createWebSearchTool(mode)],
	} satisfies PayloadWithTools;
}

export function isOpenAIHostedWebSearchModel(model: Model<Api> | undefined): model is OpenAIWebSearchModel {
	return model?.api === "openai-responses" || model?.api === "openai-codex-responses";
}

function createWebSearchTool(mode: Exclude<WebSearchMode, "disabled">): WebSearchTool {
	return {
		type: "web_search",
		external_web_access: mode === "live",
	};
}

function isHostedWebSearchTool(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return value.type === "web_search" || value.type === "web_search_2025_08_26";
}

function isRecord(value: unknown): value is PayloadWithTools {
	return typeof value === "object" && value !== null;
}
