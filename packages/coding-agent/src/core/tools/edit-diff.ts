/**
 * Shared diff computation utilities for the edit and similar tools.
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { resolveToCwd } from "./path-utils.ts";

type LineEnding = "\r\n" | "\n" | "\r";

/** The file's first line break; `\n` when it has none. */
function detectLineEnding(content: string): LineEnding {
	const first = /\r\n|\n|\r/.exec(content)?.[0];
	return first === "\r\n" || first === "\r" ? first : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Original lines with their own ending; each `\r\n`, `\n`, or lone `\r` became one `\n` in normalized content. */
const ORIGINAL_LINE = /[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+/g;

function endingOf(line: string | undefined): string {
	return line?.match(/\r\n$|\n$|\r$/)?.[0] ?? "";
}

/** Use the first replaced line's ending, then the previous line; insertions use adjacent lines.
 * Fall back to the file's first ending. Use lone CR only without LF; otherwise it may be a control character.
 */
function hunkEnding(original: string, originalLines: string[], removedStart: number | undefined, baseIndex: number) {
	const neighbours = removedStart === undefined ? [baseIndex - 1, baseIndex] : [removedStart, removedStart - 1];
	const ending = neighbours.map((i) => endingOf(originalLines[i])).find(Boolean) ?? detectLineEnding(original);
	return ending === "\r" && original.includes("\n") ? "\n" : ending;
}

/**
 * Count equal lines at the start and end of both sides. Diffing only the span between them keeps a repeated line
 * next to an edit from being aligned with the replacement and swapping endings with it.
 */
function countUnchangedEdges(base: string[], edited: string[]): { prefix: number; suffix: number } {
	let prefix = 0;
	while (prefix < base.length && prefix < edited.length && base[prefix] === edited[prefix]) prefix++;
	let suffix = 0;
	const maxSuffix = Math.min(base.length, edited.length) - prefix;
	while (suffix < maxSuffix && base[base.length - 1 - suffix] === edited[edited.length - 1 - suffix]) suffix++;
	return { prefix, suffix };
}

/**
 * Concatenate line pieces. A kept lone CR followed by an LF would merge into one CRLF and join two lines; an extra
 * LF keeps both breaks, so the written file normalizes to exactly the content the diff describes.
 */
function joinLinePieces(pieces: string[]): string {
	const joined: string[] = [];
	let endsWithCr = false;
	for (const piece of pieces.filter(Boolean)) {
		joined.push(endsWithCr && piece.startsWith("\n") ? `\n${piece}` : piece);
		endsWithCr = piece.endsWith("\r");
	}
	return joined.join("");
}

type AffectedLineGroup = { startLine: number; endLine: number; editedContent: string; preservesFinalEnding: boolean };

/** Restore endings within matched line groups and copy the original bytes between them. */
export function restoreOriginalLineEndings(
	original: string,
	normalizedBase: string,
	affectedLineGroups: AffectedLineGroup[],
): string {
	const originalLines = original.match(ORIGINAL_LINE) ?? [];
	const baseLines = splitLinesWithEndings(normalizedBase);
	const chunks: string[][] = [];
	let originalLineIndex = 0;
	for (const group of affectedLineGroups) {
		chunks.push(originalLines.slice(originalLineIndex, group.startLine));
		chunks.push([restoreEditedGroup(original, originalLines, baseLines, group)]);
		originalLineIndex = group.endLine;
	}
	chunks.push(originalLines.slice(originalLineIndex));
	return joinLinePieces(chunks.flat());
}

function restoreEditedGroup(
	original: string,
	originalLines: string[],
	baseLines: string[],
	group: AffectedLineGroup,
): string {
	const editedLines = splitLinesWithEndings(group.editedContent);
	const { prefix, suffix } = countUnchangedEdges(baseLines.slice(group.startLine, group.endLine), editedLines);
	const firstChanged = group.startLine + prefix;
	const endChanged = group.endLine - suffix;
	const chunks = [originalLines.slice(group.startLine, firstChanged)];
	let baseIndex = firstChanged;
	let removedStart: number | undefined;
	const changedBase = baseLines.slice(firstChanged, endChanged);
	for (const part of Diff.diffArrays(changedBase, editedLines.slice(prefix, editedLines.length - suffix))) {
		if (part.removed) {
			removedStart = baseIndex;
		} else if (part.added) {
			const ending = hunkEnding(original, originalLines, removedStart, baseIndex);
			chunks.push(part.value.map((line) => line.replace(/\n$/, ending)));
		} else {
			chunks.push(originalLines.slice(baseIndex, baseIndex + part.value.length));
		}
		if (!part.added) baseIndex += part.value.length;
		if (!part.removed) removedStart = undefined;
	}
	chunks.push(originalLines.slice(endChanged, group.endLine));
	const restored = joinLinePieces(chunks.flat());
	const ending = endingOf(restored);
	const originalEnding = group.preservesFinalEnding ? endingOf(originalLines[group.endLine - 1]) : "";
	return ending && originalEnding ? `${restored.slice(0, -ending.length)}${originalEnding}` : restored;
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Strip trailing whitespace per line
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
	start: number;
	end: number;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
	/** Exact matches index the original content; fuzzy matches index its normalized form. */
	inOriginal: boolean;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

const DEFAULT_DUPLICATE_CONTEXT_MATCHES = 5;
const DEFAULT_DUPLICATE_CONTEXT_LINES = 2;
const DEFAULT_CONTEXT_LINE_MAX_LENGTH = 160;

type TextOccurrence = {
	index: number;
	length: number;
};

/** Normalization never adds or removes "\n", so both forms of a file split into the same number of lines. */
function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	const parts = content.split("\n");
	return parts
		.map((part, index) => (index < parts.length - 1 ? `${part}\n` : part))
		.map((line) => {
			const span = { start: offset, end: offset + line.length };
			offset = span.end;
			return span;
		});
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;

	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) throw new Error(`Base line ${i} is missing`);
		if (replacementStart >= line.start && replacementStart < line.end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content.");
	}

	let endLine = startLine;
	while (endLine < lines.length) {
		const line = lines[endLine];
		if (!line) throw new Error(`Base line ${endLine} is missing`);
		if (line.end >= replacementEnd) break;
		endLine++;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}

	return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		if (!replacement) throw new Error(`Replacement ${i} is missing`);
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

/** Apply edits to affected lines in their matching space and keep the original text between groups. */
function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: MatchedEdit[],
): { content: string; affectedLineGroups: AffectedLineGroup[] } {
	const originalLines = getLineSpans(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	const located = replacements
		.map((replacement) => ({
			replacement,
			...getReplacementLineRange(replacement.inOriginal ? originalLines : baseLines, replacement),
		}))
		.sort((a, b) => a.startLine - b.startLine || a.replacement.matchIndex - b.replacement.matchIndex);
	const groups: Array<{ startLine: number; endLine: number; replacements: MatchedEdit[] }> = [];
	for (const { replacement, startLine, endLine } of located) {
		const current = groups[groups.length - 1];
		if (!current || startLine >= current.endLine) {
			groups.push({ startLine, endLine, replacements: [replacement] });
			continue;
		}
		const other = current.replacements.find((previous) => previous.inOriginal !== replacement.inOriginal);
		if (other) {
			throw new Error(
				`edits[${other.editIndex}] and edits[${replacement.editIndex}] change the same line, but only one matched exactly. Merge them into one edit.`,
			);
		}
		current.endLine = Math.max(current.endLine, endLine);
		current.replacements.push(replacement);
	}

	let result = "";
	let originalLineIndex = 0;
	const affectedLineGroups: AffectedLineGroup[] = [];
	for (const group of groups) {
		const { startLine, endLine } = group;
		const inOriginal = group.replacements[0]?.inOriginal ?? true;
		const [content, lines] = inOriginal ? [originalContent, originalLines] : [baseContent, baseLines];
		const groupStart = lines[startLine]?.start ?? 0;
		const groupEnd = lines[endLine - 1]?.end ?? 0;
		result += originalContent.slice(
			originalLines[originalLineIndex]?.start ?? 0,
			originalLines[startLine]?.start ?? 0,
		);
		const editedContent = applyReplacements(content.slice(groupStart, groupEnd), group.replacements, groupStart);
		const preservesFinalEnding = group.replacements.every((edit) => edit.matchIndex + edit.matchLength < groupEnd);
		result += editedContent;
		affectedLineGroups.push({ startLine, endLine, editedContent, preservesFinalEnding });
		originalLineIndex = endLine;
	}
	const remainingStart = originalLines[originalLineIndex]?.start ?? originalContent.length;
	return { content: result + originalContent.slice(remainingStart), affectedLineGroups };
}

export interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** The index where the match starts (in the content that should be used for replacement) */
	index: number;
	/** Length of the matched text */
	matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	usedFuzzyMatch: boolean;
	/**
	 * The content to use for replacement operations.
	 * When exact match: original content. When fuzzy match: normalized content.
	 */
	contentForReplacement: string;
}

export interface Edit {
	oldText: string;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
	affectedLineGroups: AffectedLineGroup[];
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * When fuzzy matching is used, the returned contentForReplacement is the
 * fuzzy-normalized version of the content (trailing whitespace stripped,
 * Unicode quotes/dashes normalized to ASCII).
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	// Try exact match first
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// Try fuzzy match - work entirely in normalized space
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyOldText.length === 0 ? -1 : fuzzyContent.indexOf(fuzzyOldText);

	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// When fuzzy matching, return offsets in normalized space. Callers can use
	// the normalized content to compute replacements, then decide how much of
	// that normalized output should be written back.
	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function findTextOccurrences(content: string, oldText: string): TextOccurrence[] {
	if (oldText.length === 0) {
		return [];
	}

	const occurrences: TextOccurrence[] = [];
	let startIndex = 0;
	while (startIndex <= content.length) {
		const index = content.indexOf(oldText, startIndex);
		if (index === -1) {
			break;
		}
		occurrences.push({ index, length: oldText.length });
		// Overlapping matches are separate locations: "}\n}" occurs twice in "}\n}\n}".
		startIndex = index + 1;
	}
	return occurrences;
}

function getLineNumberAtOffset(content: string, offset: number): number {
	let lineNumber = 1;
	for (let i = 0; i < offset; i++) {
		if (content[i] === "\n") {
			lineNumber++;
		}
	}
	return lineNumber;
}

function truncateContextLine(line: string, maxLength = DEFAULT_CONTEXT_LINE_MAX_LENGTH): string {
	if (line.length <= maxLength) {
		return line;
	}
	return `${line.slice(0, maxLength - 1)}…`;
}

function formatDuplicateMatchContexts(
	content: string,
	oldText: string,
	maxMatches = DEFAULT_DUPLICATE_CONTEXT_MATCHES,
	contextLines = DEFAULT_DUPLICATE_CONTEXT_LINES,
): string {
	const occurrences = findTextOccurrences(content, oldText);
	if (occurrences.length === 0) {
		return "";
	}

	const lines = content.split("\n");
	// A final newline ends the last line; it does not start another one.
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	const lineNumberWidth = String(lines.length).length;
	const shownOccurrences = occurrences.slice(0, maxMatches);
	const blocks = shownOccurrences.map((occurrence, occurrenceIndex) => {
		const startLine = getLineNumberAtOffset(content, occurrence.index);
		const endLine = getLineNumberAtOffset(content, occurrence.index + Math.max(occurrence.length - 1, 0));
		const firstContextLine = Math.max(1, startLine - contextLines);
		const lastContextLine = Math.min(lines.length, endLine + contextLines);
		const context: string[] = [];
		for (let lineNumber = firstContextLine; lineNumber <= lastContextLine; lineNumber++) {
			const marker = lineNumber >= startLine && lineNumber <= endLine ? ">" : " ";
			const paddedLineNumber = String(lineNumber).padStart(lineNumberWidth, " ");
			context.push(`${marker} ${paddedLineNumber}: ${truncateContextLine(lines[lineNumber - 1] ?? "")}`);
		}
		return `${occurrenceIndex + 1}) line ${startLine}\n${context.join("\n")}`;
	});

	const omittedCount = occurrences.length - shownOccurrences.length;
	const omitted = omittedCount > 0 ? `\n... ${omittedCount} more match(es) omitted.` : "";
	return `\n\nDuplicate match context:\n${blocks.join("\n\n")}${omitted}`;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

function getDuplicateError(
	path: string,
	editIndex: number,
	totalEdits: number,
	occurrences: number,
	content: string,
	oldText: string,
): Error {
	const context = formatDuplicateMatchContexts(content, oldText);
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.${context}`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.${context}`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/** Match all edits against LF text; fuzzy matching changes only the affected line groups. */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		if (!edit) throw new Error(`Edit ${i} is missing`);
		if (edit.oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
	const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const initialMatch = initialMatches[i];
		if (!edit || !initialMatch) throw new Error(`Edit ${i} is missing`);
		if (!initialMatch.found) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}

		// An exact match applies to the original text, where it is unique even when fuzzy twins exist. A fuzzy match
		// applies to normalized content, so oldText is normalized too: trailing whitespace that told two lines apart
		// no longer does there.
		const inOriginal = !initialMatch.usedFuzzyMatch;
		const searchContent = inOriginal ? normalizedContent : replacementBaseContent;
		const searchText = inOriginal ? edit.oldText : normalizeForFuzzyMatch(edit.oldText);
		const occurrences = findTextOccurrences(searchContent, searchText).length;
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences, searchContent, searchText);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: initialMatch.index,
			matchLength: initialMatch.matchLength,
			newText: edit.newText,
			inOriginal,
		});
	}

	// Offsets are comparable only within one content; edits in different contents conflict per line, checked later.
	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (const inOriginal of [true, false]) {
		const sameContent = matchedEdits.filter((edit) => edit.inOriginal === inOriginal);
		for (let i = 1; i < sameContent.length; i++) {
			const previous = sameContent[i - 1];
			const current = sameContent[i];
			if (!previous || !current) throw new Error(`Matched edit ${i} is missing`);
			if (previous.matchIndex + previous.matchLength > current.matchIndex) {
				throw new Error(
					`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
				);
			}
		}
	}

	const baseContent = normalizedContent;
	const { content: newContent, affectedLineGroups } = applyReplacementsPreservingUnchangedLines(
		normalizedContent,
		replacementBaseContent,
		matchedEdits,
	);

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent, affectedLineGroups };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (!part) throw new Error(`Diff part ${i} is missing`);
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPart = parts[i + 1];
			const nextPartIsChange = nextPart !== undefined && (nextPart.added || nextPart.removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// Read the file
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// Generate the diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}
