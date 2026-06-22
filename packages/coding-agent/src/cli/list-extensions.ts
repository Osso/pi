import { basename } from "node:path";
import type { Extension } from "../core/extensions/types.ts";

interface ExtensionInventoryRow {
	scope: string;
	source: string;
	extension: string;
	commands: string;
	tools: string;
	handlers: string;
}

function pad(value: string, width: number): string {
	return value.padEnd(width);
}

function formatRows(headers: ExtensionInventoryRow, rows: ExtensionInventoryRow[]): string[] {
	const widths = {
		scope: Math.max(headers.scope.length, ...rows.map((row) => row.scope.length)),
		source: Math.max(headers.source.length, ...rows.map((row) => row.source.length)),
		extension: Math.max(headers.extension.length, ...rows.map((row) => row.extension.length)),
		commands: Math.max(headers.commands.length, ...rows.map((row) => row.commands.length)),
		tools: Math.max(headers.tools.length, ...rows.map((row) => row.tools.length)),
		handlers: Math.max(headers.handlers.length, ...rows.map((row) => row.handlers.length)),
	};

	return [
		[
			pad(headers.scope, widths.scope),
			pad(headers.source, widths.source),
			pad(headers.extension, widths.extension),
			pad(headers.commands, widths.commands),
			pad(headers.tools, widths.tools),
			pad(headers.handlers, widths.handlers),
		].join("  "),
		[
			"-".repeat(widths.scope),
			"-".repeat(widths.source),
			"-".repeat(widths.extension),
			"-".repeat(widths.commands),
			"-".repeat(widths.tools),
			"-".repeat(widths.handlers),
		].join("  "),
		...rows.map((row) =>
			[
				pad(row.scope, widths.scope),
				pad(row.source, widths.source),
				pad(row.extension, widths.extension),
				pad(row.commands, widths.commands),
				pad(row.tools, widths.tools),
				pad(row.handlers, widths.handlers),
			]
				.join("  ")
				.trimEnd(),
		),
	].map((line) => line.trimEnd());
}

export function formatExtensionInventory(extensions: Extension[]): string {
	if (extensions.length === 0) {
		return "Loaded extensions: none";
	}

	const rows = [...extensions]
		.sort((a, b) => a.path.localeCompare(b.path))
		.map((extension) => ({
			scope: extension.sourceInfo.scope,
			source: extension.sourceInfo.source,
			extension: basename(extension.path),
			commands: extension.commands.size.toString(),
			tools: extension.tools.size.toString(),
			handlers: extension.handlers.size.toString(),
		}));

	return [
		`Loaded extensions (${rows.length})`,
		"",
		...formatRows(
			{
				scope: "scope",
				source: "source",
				extension: "extension",
				commands: "commands",
				tools: "tools",
				handlers: "handlers",
			},
			rows,
		),
	].join("\n");
}

export function listExtensions(extensions: Extension[]): void {
	console.log(formatExtensionInventory(extensions));
}
