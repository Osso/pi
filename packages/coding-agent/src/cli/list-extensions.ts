import { basename, dirname } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
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
	return value + " ".repeat(width - visibleWidth(value));
}

function isFirstPartyPath(path: string): boolean {
	return path.startsWith("<first-party:") && path.endsWith(">");
}

function extensionLabel(extension: Extension): string {
	if (isFirstPartyPath(extension.path)) {
		return extension.path.slice("<first-party:".length, -1);
	}
	const file = basename(extension.path);
	// Directory extensions all load `index.*`; their directory is what tells them apart.
	return /^index\.[cm]?[jt]s$/.test(file) ? `${basename(dirname(extension.path))}/${file}` : file;
}

function scopeLabel(extension: Extension): string {
	return isFirstPartyPath(extension.path) ? "runtime" : extension.sourceInfo.scope;
}

function sourceLabel(extension: Extension): string {
	return isFirstPartyPath(extension.path) ? "built-in" : extension.sourceInfo.source;
}

function formatRows(headers: ExtensionInventoryRow, rows: ExtensionInventoryRow[]): string[] {
	const columnWidth = (key: keyof ExtensionInventoryRow) =>
		Math.max(visibleWidth(headers[key]), ...rows.map((row) => visibleWidth(row[key])));
	const widths = {
		scope: columnWidth("scope"),
		source: columnWidth("source"),
		extension: columnWidth("extension"),
		commands: columnWidth("commands"),
		tools: columnWidth("tools"),
		handlers: columnWidth("handlers"),
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

function disambiguateExtensionLabels(rows: Array<ExtensionInventoryRow & { path: string }>): ExtensionInventoryRow[] {
	const labelKey = (row: ExtensionInventoryRow) => JSON.stringify([row.scope, row.source, row.extension]);
	const labelCounts = new Map<string, number>();
	for (const row of rows) {
		const key = labelKey(row);
		labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
	}
	return rows.map((row) => ((labelCounts.get(labelKey(row)) ?? 0) > 1 ? { ...row, extension: row.path } : row));
}

export function formatExtensionInventory(extensions: Extension[]): string {
	if (extensions.length === 0) {
		return "Loaded extensions: none";
	}

	const rows = [...extensions]
		.sort((a, b) => a.path.localeCompare(b.path))
		.map((extension) => ({
			path: extension.path,
			scope: scopeLabel(extension),
			source: sourceLabel(extension),
			extension: extensionLabel(extension),
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
			disambiguateExtensionLabels(rows),
		),
	].join("\n");
}

export function listExtensions(extensions: Extension[]): void {
	console.log(formatExtensionInventory(extensions));
}
