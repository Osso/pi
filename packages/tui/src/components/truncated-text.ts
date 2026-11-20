import type { Component } from "../tui.ts";
import { truncateToWidth } from "../utils.ts";

/**
 * Text component that truncates to fit viewport width
 */
export class TruncatedText implements Component {
	private text: string;
	private paddingX: number;
	private paddingY: number;

	constructor(text: string, paddingX: number = 0, paddingY: number = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const result: string[] = [];

		// Empty line padded to width
		const emptyLine = " ".repeat(width);

		// Add vertical padding above
		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		// Calculate available width after horizontal padding
		const availableWidth = Math.max(1, width - this.paddingX * 2);

		// Take only the first line; a CR left in the output would return the cursor and let padding erase the text
		const singleLineText = this.text.split(/\r\n|\r|\n/, 1)[0] ?? "";

		// Truncate text if needed (accounting for ANSI codes)
		const displayText = truncateToWidth(singleLineText, availableWidth);

		// Add horizontal padding
		const leftPadding = " ".repeat(this.paddingX);
		const rightPadding = " ".repeat(this.paddingX);
		const lineWithPadding = leftPadding + displayText + rightPadding;

		// Fit the line to exactly width characters; padding wider than the viewport is cut
		const finalLine = truncateToWidth(lineWithPadding, width, "", true);

		result.push(finalLine);

		// Add vertical padding below
		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		return result;
	}
}
