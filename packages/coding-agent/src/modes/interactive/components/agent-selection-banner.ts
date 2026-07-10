import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentSnapshot, MultiAgentStore } from "../../../core/multi-agent-store.ts";
import { theme } from "../theme/theme.ts";

function formatLifecycle(lifecycle: AgentSnapshot["lifecycle"]): string {
	return lifecycle.replace(/_/g, " ");
}

function selectedAgentText(store: MultiAgentStore | undefined): string | undefined {
	const selectedAgentId = store?.getSelectedAgentId();
	const selectedAgent = selectedAgentId ? store?.getAgent(selectedAgentId) : undefined;
	if (!selectedAgent) {
		return undefined;
	}

	return `Agent ${selectedAgent.id}: ${selectedAgent.displayName} (${formatLifecycle(selectedAgent.lifecycle)})`;
}

export class AgentSelectionBannerComponent implements Component {
	private readonly store: MultiAgentStore | undefined;

	constructor(store: MultiAgentStore | undefined) {
		this.store = store;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const text = selectedAgentText(this.store);
		if (!text) {
			return [];
		}
		const label = theme.fg("accent", theme.bold(text));
		return [truncateToWidth(label, width, "")];
	}
}
