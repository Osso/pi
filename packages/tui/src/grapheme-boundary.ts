/**
 * The start of the grapheme that contains `offset`, or `offset` itself when it is already on a boundary or at
 * or past the end. Edits can join graphemes (deleting `x` from "🇺x🇸" makes one flag), and a cursor must never
 * stay inside one.
 */
export function graphemeStartAt(graphemes: Iterable<Intl.SegmentData>, offset: number): number {
	for (const { index, segment } of graphemes) {
		if (index + segment.length > offset) return index;
	}
	return offset;
}
