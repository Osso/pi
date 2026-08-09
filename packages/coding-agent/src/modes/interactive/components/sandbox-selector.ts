import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import {
	SANDBOX_PROFILES,
	type SandboxProfileName,
	type SandboxProfileScope,
} from "../../../core/permissions/presets.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export type SandboxSelectorSelection =
	| { profile: SandboxProfileName; scope: "global" | "project" }
	| { profile: SandboxProfileName | undefined; scope: "session" };

export interface SandboxSelectorOptions {
	currentProfile: SandboxProfileName;
	sessionProfile?: SandboxProfileName;
	onSelect: (selection: SandboxSelectorSelection) => void;
	onCancel: () => void;
}

type SandboxSelectorOption = {
	label: string;
	profile: SandboxProfileName | undefined;
};

const SANDBOX_SCOPES: SandboxProfileScope[] = ["global", "project", "session"];
const SESSION_INHERIT_OPTION: SandboxSelectorOption = {
	label: "Inherit global/project",
	profile: undefined,
};

export class SandboxSelectorComponent extends Container {
	private selectedIndex: number;
	private scope: SandboxProfileScope = "global";
	private readonly listContainer = new Container();
	private readonly onSelectCallback: (selection: SandboxSelectorSelection) => void;
	private readonly onCancelCallback: () => void;
	private readonly currentProfile: SandboxProfileName;
	private readonly sessionProfile: SandboxProfileName | undefined;

	constructor(options: SandboxSelectorOptions) {
		super();

		this.currentProfile = options.currentProfile;
		this.sessionProfile = options.sessionProfile;
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;
		this.selectedIndex = this.selectedIndexForScope();

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Sandbox profiles")), 1, 0));
		this.addChild(new Text(theme.fg("muted", "Tab switches save scope: global/project/session"), 1, 0));
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

	private optionsForScope(): SandboxSelectorOption[] {
		const profiles = SANDBOX_PROFILES.map((profile) => ({ label: profile.label, profile: profile.name }));
		return this.scope === "session" ? [SESSION_INHERIT_OPTION, ...profiles] : profiles;
	}

	private selectedIndexForScope(): number {
		const activeProfile = this.scope === "session" ? this.sessionProfile : this.currentProfile;
		return Math.max(
			0,
			this.optionsForScope().findIndex((option) => option.profile === activeProfile),
		);
	}

	private cycleScope(): void {
		const currentIndex = SANDBOX_SCOPES.indexOf(this.scope);
		this.scope = SANDBOX_SCOPES[(currentIndex + 1) % SANDBOX_SCOPES.length] ?? "global";
		this.selectedIndex = this.selectedIndexForScope();
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		this.listContainer.addChild(new Text(theme.fg("muted", `Save scope: ${this.scope}`), 1, 0));
		this.listContainer.addChild(new Spacer(1));
		const activeProfile = this.scope === "session" ? this.sessionProfile : this.currentProfile;
		for (const [index, option] of this.optionsForScope().entries()) {
			const isSelected = index === this.selectedIndex;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const label = isSelected ? theme.fg("accent", option.label) : theme.fg("text", option.label);
			const checkmark = option.profile === activeProfile ? theme.fg("success", " ✓") : "";
			this.listContainer.addChild(new Text(`${prefix}${label}${checkmark}`, 1, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const options = this.optionsForScope();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (keyData === "\t") {
			this.cycleScope();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = options[this.selectedIndex];
			if (!selected) return;
			if (this.scope === "session") {
				this.onSelectCallback({ profile: selected.profile, scope: "session" });
			} else if (selected.profile) {
				this.onSelectCallback({ profile: selected.profile, scope: this.scope });
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}
}
