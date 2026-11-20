import * as Diff from "diff";
import { theme } from "../theme/theme.ts";

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	// `s`: content may contain U+2028/U+2029, which `.` does not match otherwise.
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/s);
	if (!match) return null;
	const [, prefix, lineNum, content] = match;
	if (prefix === undefined || lineNum === undefined || content === undefined) return null;
	return { prefix, lineNum, content };
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Uses diffWordsWithSpace: diffWords ignores whitespace and copies shared text from the new line, which hides
 * whitespace-only changes in the removed line.
 * Diffs the raw text and expands tabs per part, so a tab replaced by spaces is still marked.
 * Leading whitespace of a change at the start of the text is indentation and is not inverted.
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	// Shared indentation stays outside the word diff, so an insertion at the start of the text cannot consume it.
	const oldIndent = oldContent.match(/^\s*/)?.[0] ?? "";
	let indentLength = 0;
	while (indentLength < oldIndent.length && oldIndent[indentLength] === newContent[indentLength]) indentLength++;
	const wordDiff = Diff.diffWordsWithSpace(oldContent.slice(indentLength), newContent.slice(indentLength));

	let removedLine = replaceTabs(oldContent.slice(0, indentLength));
	let addedLine = removedLine;
	let removedAtStart = true;
	let addedAtStart = true;
	const renderChange = (value: string, atStart: boolean): string => {
		const leadingWs = atStart ? (value.match(/^\s*/)?.[0] ?? "") : "";
		const changed = value.slice(leadingWs.length);
		return replaceTabs(leadingWs) + (changed ? theme.inverse(replaceTabs(changed)) : "");
	};

	for (const part of wordDiff) {
		if (part.removed) {
			removedLine += renderChange(part.value, removedAtStart);
			removedAtStart = false;
		} else if (part.added) {
			addedLine += renderChange(part.value, addedAtStart);
			addedAtStart = false;
		} else {
			removedLine += replaceTabs(part.value);
			addedLine += replaceTabs(part.value);
			removedAtStart = false;
			addedAtStart = false;
		}
	}

	return { removedLine, addedLine };
}

export interface RenderDiffOptions {
	/** File path (unused, kept for API compatibility) */
	filePath?: string;
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with inverse on changed tokens
 * - Added lines: green, with inverse on changed tokens
 */
export function renderDiff(diffText: string, _options: RenderDiffOptions = {}): string {
	const lines = diffText.split("\n");
	const result: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line === undefined) break;
		const parsed = parseDiffLine(line);

		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			// Collect consecutive removed lines
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const line = lines[i];
				if (line === undefined) break;
				const p = parseDiffLine(line);
				if (!p || p.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Collect consecutive added lines
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const line = lines[i];
				if (line === undefined) break;
				const p = parseDiffLine(line);
				if (!p || p.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Only do intra-line diffing when there's exactly one removed and one added line
			// (indicating a single line modification). Otherwise, show lines as-is.
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];
				if (!removed || !added) throw new Error("Expected one removed and one added diff line");

				const { removedLine, addedLine } = renderIntraLineDiff(removed.content, added.content);

				result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${removedLine}`));
				result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${addedLine}`));
			} else {
				// Show all removed lines first, then all added lines
				for (const removed of removedLines) {
					result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${replaceTabs(removed.content)}`));
				}
				for (const added of addedLines) {
					result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${replaceTabs(added.content)}`));
				}
			}
		} else if (parsed.prefix === "+") {
			// Standalone added line
			result.push(theme.fg("toolDiffAdded", `+${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		} else {
			// Context line
			result.push(theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		}
	}

	return result.join("\n");
}
