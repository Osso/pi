import { type Component, Container } from "@earendil-works/pi-tui";
import { CustomMessageComponent } from "./custom-message.ts";
import { UserMessageComponent } from "./user-message.ts";

/** Keeps message components intact while toggling only their rendered lines. */
export class CoordinationMessageComponent extends Container {
	private readonly isHidden: () => boolean;

	constructor(components: Component[], isHidden: () => boolean) {
		super();
		this.isHidden = isHidden;
		for (const component of components) this.addChild(component);
	}

	override render(width: number): string[] {
		return this.isHidden() ? [] : super.render(width);
	}

	setExpanded(expanded: boolean): void {
		for (const child of this.children) {
			if (child instanceof CustomMessageComponent) child.setExpanded(expanded);
		}
	}

	setInTransit(inTransit: boolean): void {
		for (const child of this.children) {
			if (child instanceof UserMessageComponent) child.setInTransit(inTransit);
		}
	}
}
