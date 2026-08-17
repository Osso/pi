import type { Component } from "@earendil-works/pi-tui";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { EntryRenderer, EntryRenderOptions } from "../../../core/extensions/types.ts";
import type { CustomEntry } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.ts";

/**
 * Component that renders a custom session entry from extensions.
 * The host owns transcript spacing; renderer output should provide only its content.
 */
export interface CustomEntryComponentOptions {
	requestRender: (component: CustomEntryComponent) => boolean;
	sessionId: string;
}

export class CustomEntryComponent extends Container {
	private entry: CustomEntry<unknown>;
	private renderer: EntryRenderer;
	private readonly options: CustomEntryComponentOptions;
	private customComponent?: Component;
	private cleanupCallbacks = new Set<() => void>();
	private _expanded = false;

	constructor(entry: CustomEntry<unknown>, renderer: EntryRenderer, options: CustomEntryComponentOptions) {
		super();
		this.entry = entry;
		this.renderer = renderer;
		this.options = options;
		this.rebuild();
	}

	hasContent(): boolean {
		return this.customComponent !== undefined;
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	dispose(): void {
		this.disposeRenderedComponent();
		this.children = [];
	}

	private rebuild(): void {
		this.disposeRenderedComponent();
		this.children = [];

		const renderOptions: EntryRenderOptions = {
			expanded: this._expanded,
			requestRender: () => this.options.requestRender(this),
			sessionId: this.options.sessionId,
			registerCleanup: (cleanup) => this.cleanupCallbacks.add(cleanup),
		};
		let component: Component | undefined;
		try {
			component = this.renderer(this.entry, renderOptions, theme);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
			box.addChild(new Text(theme.fg("error", `[${this.entry.customType}] renderer failed: ${message}`), 0, 0));
			component = box;
		}

		if (!component) {
			return;
		}

		this.customComponent = component;
		this.addChild(new Spacer(1));
		this.addChild(component);
	}

	private disposeRenderedComponent(): void {
		for (const cleanup of this.cleanupCallbacks) cleanup();
		this.cleanupCallbacks.clear();
		const disposable = this.customComponent as (Component & { dispose?: () => void }) | undefined;
		disposable?.dispose?.();
		this.customComponent = undefined;
	}
}
