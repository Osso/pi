import type { Component } from "../tui.ts";

export class DynamicBorder implements Component {
	private readonly format: (line: string) => string;

	constructor(format: (line: string) => string = (line) => line) {
		this.format = format;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return [this.format("─".repeat(Math.max(1, width)))];
	}
}
