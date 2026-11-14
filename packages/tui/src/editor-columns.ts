import { getGraphemeSegmenter, visibleWidth } from "./utils.ts";

/** Last cursor cell on a visual line; only final segments allow an end position. */
export function maxCursorColumn(text: string, allowEnd: boolean): number {
	const end = allowEnd ? text.length : ([...getGraphemeSegmenter().segment(text)].at(-1)?.index ?? 0);
	return visibleWidth(text.slice(0, end));
}
