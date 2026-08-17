import { type Component, Container, type RenderRegion, type RenderRegionRect, type TUI } from "@earendil-works/pi-tui";

type DisposableComponent = Component & { dispose?: () => void };
type RegionTUI = Pick<TUI, "createRenderRegion">;

export class RenderRegionContainer extends Container {
	private readonly tui: RegionTUI;
	private readonly scopedChildren = new Set<Component>();
	private readonly childRegions = new Map<Component, RenderRegion>();
	private childLayouts = new Map<Component, RenderRegionRect>();
	private layout: RenderRegionRect | undefined;

	constructor(tui: RegionTUI) {
		super();
		this.tui = tui;
	}

	trackScopedChild(component: Component): void {
		this.scopedChildren.add(component);
	}

	place(layout: RenderRegionRect): void {
		this.layout = { ...layout };
		for (const [component, region] of this.childRegions) {
			this.placeChildRegion(component, region);
		}
	}

	requestChildRender(component: Component): boolean {
		if (!this.scopedChildren.has(component) || !this.children.includes(component)) {
			return false;
		}

		let region = this.childRegions.get(component);
		if (!region) {
			region = this.tui.createRenderRegion(component);
			this.childRegions.set(component, region);
		}
		if (!this.placeChildRegion(component, region)) {
			return false;
		}
		return region.tryRender();
	}

	override removeChild(component: Component): void {
		this.disposeScopedChild(component);
		super.removeChild(component);
	}

	override clear(): void {
		for (const component of this.scopedChildren) {
			this.disposeScopedChild(component);
		}
		this.childLayouts.clear();
		this.layout = undefined;
		super.clear();
	}

	override render(width: number): string[] {
		const lines: string[] = [];
		const childLayouts = new Map<Component, RenderRegionRect>();
		for (const child of this.children) {
			const childLines = child.render(width);
			if (this.scopedChildren.has(child)) {
				childLayouts.set(child, { row: lines.length, col: 0, width, height: childLines.length });
			}
			lines.push(...childLines);
		}
		this.childLayouts = childLayouts;
		return lines;
	}

	private placeChildRegion(component: Component, region: RenderRegion): boolean {
		const childLayout = this.childLayouts.get(component);
		if (!this.layout || !childLayout) {
			region.clear();
			return false;
		}

		region.place({
			row: this.layout.row + childLayout.row,
			col: this.layout.col + childLayout.col,
			width: childLayout.width,
			height: childLayout.height,
		});
		return true;
	}

	private disposeScopedChild(component: Component): void {
		if (!this.scopedChildren.delete(component)) {
			return;
		}
		this.childLayouts.delete(component);
		this.childRegions.get(component)?.dispose();
		this.childRegions.delete(component);
		(component as DisposableComponent).dispose?.();
	}
}
