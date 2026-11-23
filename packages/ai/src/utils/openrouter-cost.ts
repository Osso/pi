import type { Model, Usage } from "../types.ts";

/** Billing fields OpenRouter adds to streamed usage at runtime; the OpenAI SDK does not type them. */
export interface OpenRouterUsageAccounting {
	/** Amount charged to the user's OpenRouter account. */
	cost?: number | null;
	/** Whether OpenRouter used the user's upstream provider key. */
	is_byok?: boolean;
	cost_details?: {
		/** Total inference cost billed through the user's upstream provider account, when available. */
		upstream_inference_cost?: number | null;
		upstream_inference_prompt_cost?: number;
		upstream_inference_completions_cost?: number;
	} | null;
}

function isValidCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function getBilledTotal(reported: OpenRouterUsageAccounting): number | undefined {
	if (!isValidCost(reported.cost)) return undefined;
	if (reported.is_byok === false) return reported.cost;
	if (reported.is_byok !== true || !reported.cost_details) return undefined;
	const details = reported.cost_details;
	const upstreamCost =
		details.upstream_inference_cost ??
		(isValidCost(details.upstream_inference_prompt_cost) && isValidCost(details.upstream_inference_completions_cost)
			? details.upstream_inference_prompt_cost + details.upstream_inference_completions_cost
			: undefined);
	return isValidCost(upstreamCost) ? reported.cost + upstreamCost : undefined;
}

/**
 * For OpenRouter models, replace the catalog total with OpenRouter's billed cost when the usage contains complete,
 * valid accounting. BYOK requests add the upstream inference cost. The component costs remain catalog estimates.
 */
export function applyOpenRouterReportedCost(
	model: Pick<Model<string>, "provider" | "baseUrl">,
	usage: Usage,
	rawUsage: OpenRouterUsageAccounting,
): void {
	if (model.provider !== "openrouter" && !model.baseUrl.includes("openrouter.ai")) return;
	const billedTotal = getBilledTotal(rawUsage);
	if (billedTotal !== undefined) usage.cost.total = billedTotal;
}
