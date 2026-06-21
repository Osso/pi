import { Container } from "@earendil-works/pi-tui";
import type { ApprovalPresetName } from "../../../core/permissions/presets.ts";

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
	constructor(_options: ApprovalSelectorOptions) {
		super();
	}

	handleInput(_keyData: string): void {}
}
