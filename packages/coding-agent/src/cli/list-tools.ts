import type { ToolInfo } from "../core/extensions/types.ts";

interface ToolInventoryRow {
	active: string;
	name: string;
	source: string;
	description: string;
}

function pad(value: string, width: number): string {
	return value.padEnd(width);
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

function formatRows(headers: ToolInventoryRow, rows: ToolInventoryRow[]): string[] {
	const widths = {
		active: Math.max(headers.active.length, ...rows.map((row) => row.active.length)),
		name: Math.max(headers.name.length, ...rows.map((row) => row.name.length)),
		source: Math.max(headers.source.length, ...rows.map((row) => row.source.length)),
		description: Math.max(headers.description.length, ...rows.map((row) => row.description.length)),
	};

	return [
		[
			pad(headers.active, widths.active),
			pad(headers.name, widths.name),
			pad(headers.source, widths.source),
			pad(headers.description, widths.description),
		].join("  "),
		[
			"-".repeat(widths.active),
			"-".repeat(widths.name),
			"-".repeat(widths.source),
			"-".repeat(widths.description),
		].join("  "),
		...rows.map((row) =>
			[
				pad(row.active, widths.active),
				pad(row.name, widths.name),
				pad(row.source, widths.source),
				pad(row.description, widths.description),
			]
				.join("  ")
				.trimEnd(),
		),
	].map((line) => line.trimEnd());
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
			description: tool.description,
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
