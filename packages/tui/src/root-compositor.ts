import type { Component, RenderRegionRect } from "./tui.ts";

export type RootLayoutRect = RenderRegionRect;

export interface RootLayoutEntry {
	component: Component;
	onLayout?: (rect: RootLayoutRect) => void;
}

export interface RootCompositorOptions {
	getHeight: () => number;
	flow: RootLayoutEntry[];
	bottom: RootLayoutEntry[];
}

type RenderedEntry = {
	entry: RootLayoutEntry;
	lines: string[];
};

function renderEntries(entries: RootLayoutEntry[], width: number): RenderedEntry[] {
	return entries.map((entry) => ({ entry, lines: entry.component.render(width) }));
}

function totalHeight(entries: RenderedEntry[]): number {
	return entries.reduce((height, entry) => height + entry.lines.length, 0);
}

function notifyLayout(entries: RenderedEntry[], startRow: number, width: number): void {
	let row = startRow;
	for (const { entry, lines } of entries) {
		entry.onLayout?.({ row, col: 0, width, height: lines.length });
		row += lines.length;
	}
}

export class RootCompositor implements Component {
	private readonly getHeight: () => number;
	private readonly flow: RootLayoutEntry[];
	private readonly bottom: RootLayoutEntry[];

	constructor(options: RootCompositorOptions) {
		this.getHeight = options.getHeight;
		this.flow = options.flow;
		this.bottom = options.bottom;
	}

	render(width: number): string[] {
		const flow = renderEntries(this.flow, width);
		const bottom = renderEntries(this.bottom, width);
		const flowHeight = totalHeight(flow);
		const bottomHeight = totalHeight(bottom);
		const viewportHeight = Math.max(0, Math.floor(this.getHeight()));
		const gapHeight = Math.max(0, viewportHeight - flowHeight - bottomHeight);
		const bottomRow = flowHeight + gapHeight;

		notifyLayout(flow, 0, width);
		notifyLayout(bottom, bottomRow, width);

		return [
			...flow.flatMap((entry) => entry.lines),
			...Array.from({ length: gapHeight }, () => ""),
			...bottom.flatMap((entry) => entry.lines),
		];
	}

	invalidate(): void {
		for (const { component } of [...this.flow, ...this.bottom]) {
			component.invalidate();
		}
	}
}
