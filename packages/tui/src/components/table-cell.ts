import { visibleWidth } from "../utils.ts";

/** Pad rendered cell text to the column width, honoring the GFM column alignment. */
export function padTableCell(
	text: string,
	width: number,
	align: "left" | "center" | "right" | null | undefined,
): string {
	const gap = Math.max(0, width - visibleWidth(text));
	const left = align === "right" ? gap : align === "center" ? Math.floor(gap / 2) : 0;
	return " ".repeat(left) + text + " ".repeat(gap - left);
}
