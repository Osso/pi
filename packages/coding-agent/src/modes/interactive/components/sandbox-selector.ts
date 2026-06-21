import { Container } from "@earendil-works/pi-tui";
import type { SandboxProfileName } from "../../../core/permissions/presets.ts";

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
	constructor(_options: SandboxSelectorOptions) {
		super();
	}

	handleInput(_keyData: string): void {}
}
