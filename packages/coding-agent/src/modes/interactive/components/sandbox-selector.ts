import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { SANDBOX_PROFILES, type SandboxProfileName } from "../../../core/permissions/presets.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export type SandboxSelectorSelection = {
	profile: SandboxProfileName;
	scope: "global" | "project";
};

export interface SandboxSelectorOptions {
	currentProfile: SandboxProfileName;
	onSelect: (selection: SandboxSelectorSelection) => void;
	onCancel: () => void;
}

export class SandboxSelectorComponent extends Container {
	private selectedIndex: number;
	private scope: SandboxSelectorSelection["scope"] = "global";
	private readonly listContainer = new Container();
	private readonly onSelectCallback: (selection: SandboxSelectorSelection) => void;
	private readonly onCancelCallback: () => void;
	private readonly currentProfile: SandboxProfileName;

	constructor(options: SandboxSelectorOptions) {
		super();

		this.currentProfile = options.currentProfile;
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;
		this.selectedIndex = Math.max(
			0,
			SANDBOX_PROFILES.findIndex((profile) => profile.name === options.currentProfile),
		);

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Sandbox profiles")), 1, 0));
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

		for (let i = 0; i < SANDBOX_PROFILES.length; i++) {
			const profile = SANDBOX_PROFILES[i];
			if (!profile) {
				continue;
			}

			const isSelected = i === this.selectedIndex;
			const isCurrent = profile.name === this.currentProfile;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const label = isSelected ? theme.fg("accent", profile.label) : theme.fg("text", profile.label);
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
			this.selectedIndex = Math.min(SANDBOX_PROFILES.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (keyData === "\t") {
			this.scope = this.scope === "global" ? "project" : "global";
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = SANDBOX_PROFILES[this.selectedIndex];
			if (selected) {
				this.onSelectCallback({ profile: selected.name, scope: this.scope });
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}
}
