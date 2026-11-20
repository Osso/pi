import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolInfo } from "../core/extensions/types.ts";

interface ToolInventoryRow {
	active: string;
	name: string;
	source: string;
	description: string;
}

const DESCRIPTION_WIDTH = 54;

function pad(value: string, width: number): string {
	return value + " ".repeat(width - visibleWidth(value));
}

function sourceLabel(tool: ToolInfo): string {
	if (tool.sourceInfo.source.startsWith("extension:")) {
		return tool.sourceInfo.source;
	}
	if (tool.sourceInfo.source === "sdk") {
		return "sdk";
	}
	return tool.sourceInfo.path.startsWith("<builtin:") ? "builtin" : tool.sourceInfo.source;
}

function truncateDescription(description: string): string {
	const singleLine = description.replace(/\s+/g, " ").trim();
	if (visibleWidth(singleLine) <= DESCRIPTION_WIDTH) return singleLine;
	const ellipsis = "...";
	const prefix = sliceByColumn(singleLine, 0, DESCRIPTION_WIDTH - ellipsis.length, true);
	return prefix.trimEnd() + ellipsis;
}

function formatRows(headers: ToolInventoryRow, rows: ToolInventoryRow[]): string[] {
	const keys = ["active", "name", "source", "description"] as const;
	const columns = keys.map((key) => ({
		key,
		width: Math.max(visibleWidth(headers[key]), ...rows.map((row) => visibleWidth(row[key]))),
	}));
	const renderRow = (row: ToolInventoryRow) =>
		columns
			.map(({ key, width }) => pad(row[key], width))
			.join("  ")
			.trimEnd();
	return [renderRow(headers), columns.map(({ width }) => "-".repeat(width)).join("  "), ...rows.map(renderRow)];
}

export function formatToolInventory(tools: ToolInfo[], activeToolNames: string[]): string {
	if (tools.length === 0) {
		return "Available tools: none";
	}

	const active = new Set(activeToolNames);
	const rows = [...tools]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((tool) => ({
			active: active.has(tool.name) ? "yes" : "no",
			name: tool.name,
			source: sourceLabel(tool),
			description: truncateDescription(tool.description),
		}));

	return [
		`Available tools (${rows.length})`,
		"",
		...formatRows({ active: "active", name: "tool", source: "source", description: "description" }, rows),
	].join("\n");
}

export function listTools(tools: ToolInfo[], activeToolNames: string[]): void {
	console.log(formatToolInventory(tools, activeToolNames));
}
