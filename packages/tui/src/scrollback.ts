import { visibleWidth } from "./utils.ts";

/**
 * Returns the row of `next` where the rows of the previous viewport now start, after lines above the viewport
 * changed. Rows above the old viewport are already in scrollback; repainting from a row that is still in
 * scrollback would scroll those rows into history twice.
 *
 * The previous viewport rows are aligned with `next` at the start row where most of them match, so the shift
 * is found even when a visible row changed or rows were appended in the same frame. Ties prefer the shift
 * implied by the length change. Blank rows repeat too often to anchor the alignment, so only rows with visible
 * text count. When most of those differ the viewport content itself changed and the old row is kept.
 */
export function viewportTopAfterOffscreenChange(
	previous: readonly string[],
	next: readonly string[],
	viewportTop: number,
): number {
	const viewportRows = previous.length - viewportTop;
	const lengthShiftedTop = next.length - viewportRows;
	const textRows: number[] = [];
	for (let row = 0; row < viewportRows; row++) {
		if (visibleWidth(previous[viewportTop + row] ?? "") > 0) textRows.push(row);
	}
	const matchesAt = (top: number): number =>
		textRows.filter((row) => top + row < next.length && previous[viewportTop + row] === next[top + row]).length;
	const isUnchangedSuffix =
		lengthShiftedTop >= 0 && previous.slice(viewportTop).every((line, row) => line === next[lengthShiftedTop + row]);
	// Common case: only rows above changed, so the old viewport is an unchanged suffix.
	if (isUnchangedSuffix) return lengthShiftedTop;
	let bestTop = viewportTop;
	let bestMatches = 0;
	for (let top = 0; top < next.length; top++) {
		const matches = matchesAt(top);
		const closer = Math.abs(top - lengthShiftedTop) < Math.abs(bestTop - lengthShiftedTop);
		if (matches > bestMatches || (matches === bestMatches && closer)) {
			bestTop = top;
			bestMatches = matches;
		}
	}
	return bestMatches * 2 > textRows.length ? bestTop : viewportTop;
}
