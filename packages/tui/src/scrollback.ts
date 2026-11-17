/**
 * Returns the row of `next` where the rows of the previous viewport now start, after lines above the viewport
 * changed. When the previous viewport rows are an unchanged suffix of `next`, they moved by the rows added or
 * removed above them; repainting from the old row would put rows that are already in scrollback on screen again,
 * and scroll them into history twice. Otherwise the viewport content changed too and the old row is kept.
 */
export function viewportTopAfterOffscreenChange(
	previous: readonly string[],
	next: readonly string[],
	viewportTop: number,
): number {
	const viewportRows = previous.length - viewportTop;
	const shiftedTop = next.length - viewportRows;
	if (shiftedTop < 0) return viewportTop;
	for (let row = 0; row < viewportRows; row++) {
		if (previous[viewportTop + row] !== next[shiftedTop + row]) return viewportTop;
	}
	return shiftedTop;
}
