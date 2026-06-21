import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { APPROVAL_PRESETS, type ApprovalPresetName } from "../../../core/permissions/presets.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export type ApprovalSelectorSelection = {
	preset: ApprovalPresetName;
	scope: "global" | "project";
};

export interface ApprovalSelectorOptions {
	currentPreset: ApprovalPresetName;
	onSelect: (selection: ApprovalSelectorSelection) => void;
	onCancel: () => void;
}

export class ApprovalSelectorComponent extends Container {
	private selectedIndex: number;
	private scope: ApprovalSelectorSelection["scope"] = "global";
	private readonly listContainer = new Container();
	private readonly onSelectCallback: (selection: ApprovalSelectorSelection) => void;
	private readonly onCancelCallback: () => void;
	private readonly currentPreset: ApprovalPresetName;

	constructor(options: ApprovalSelectorOptions) {
		super();

		this.currentPreset = options.currentPreset;
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;
		this.selectedIndex = Math.max(
			0,
			APPROVAL_PRESETS.findIndex((preset) => preset.name === options.currentPreset),
		);

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Approval presets")), 1, 0));
		this.addChild(new Text(theme.fg("muted", "Tab switches save scope: global/project"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					rawKeyHint("Tab", "scope") +
					"  " +
					keyHint("tui.select.confirm", "save") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		this.listContainer.addChild(new Text(theme.fg("muted", `Save scope: ${this.scope}`), 1, 0));
		this.listContainer.addChild(new Spacer(1));

		for (let i = 0; i < APPROVAL_PRESETS.length; i++) {
			const preset = APPROVAL_PRESETS[i];
			if (!preset) {
				continue;
			}

			const isSelected = i === this.selectedIndex;
			const isCurrent = preset.name === this.currentPreset;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const label = isSelected ? theme.fg("accent", preset.label) : theme.fg("text", preset.label);
			const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
			this.listContainer.addChild(new Text(`${prefix}${label}${checkmark}`, 1, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(APPROVAL_PRESETS.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (keyData === "\t") {
			this.scope = this.scope === "global" ? "project" : "global";
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = APPROVAL_PRESETS[this.selectedIndex];
			if (selected) {
				this.onSelectCallback({ preset: selected.name, scope: this.scope });
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}
}
