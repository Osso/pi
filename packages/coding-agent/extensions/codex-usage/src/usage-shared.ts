export interface UsageCell {
	percent: number;
	/** Epoch seconds. */
	resetsAt: number | null;
}

export interface AccountUsageRow {
	provider: string;
	account: string;
	fiveHour: UsageCell | null;
	weekly: UsageCell | null;
	/** Available reset credits, absent when not reported. */
	resetCreditsAvailable?: number | null;
	/** Error or login state; replaces the reset details. */
	status?: string;
}

import { formatPercent } from "./codex-usage.ts";

export const MISSING = "-";

export const RESET_CREDITS_LEGEND = `Resets = available reset credits; ${MISSING} = not reported`;

export const SCOPE_TITLES = {
	all: "Account usage (all accounts)",
	claude: "Claude account usage",
	openai: "OpenAI account usage",
} as const;

export const CENTRAL_RESET_FORMAT = new Intl.DateTimeFormat("sv-SE", {
	timeZone: "America/Chicago",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});

export type UsageScope = "all" | "claude" | "openai";

export interface UsageSection {
	title: string;
	table: string;
}

export function formatUsagePercent(cell: UsageCell | null): string {
	return cell ? formatPercent(cell.percent) : MISSING;
}

export function formatUsageReset(cell: UsageCell | null): string {
	if (cell?.resetsAt == null) return MISSING;
	const date = new Date(cell.resetsAt * 1000);
	return Number.isNaN(date.getTime()) ? "unknown" : CENTRAL_RESET_FORMAT.format(date);
}

export function formatUsageError(error: unknown): string {
	return sanitizeUsageText(error instanceof Error ? error.message : String(error));
}

export function sanitizeUsageText(value: string): string {
	return value
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
		.replace(/\b(?:sk-|sk-ant-)[A-Za-z0-9_-]+/g, "[redacted]")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.slice(0, 300);
}
