import {
	type Component,
	Container,
	getKeybindings,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { type AgentLifecycleState, type AgentSnapshot, isActiveLifecycle } from "../../../core/multi-agent-store.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

const MAIN_THREAD_AGENT_ID = "main";
const MAX_VISIBLE_AGENTS = 10;

function formatLifecycle(lifecycle: AgentLifecycleState): string {
	return lifecycle.replace(/_/g, " ");
}

function formatAgentId(agentId: string): string {
	return agentId.length <= 12 ? agentId : `${agentId.slice(0, 11)}…`;
}

class AgentSwitcherList implements Component {
	private readonly agents: AgentSnapshot[];
	private readonly onCancel: () => void;
	private readonly onInactiveSelect: (agent: AgentSnapshot) => void;
	private readonly onSelect: (agentId: string) => void;
	private readonly selectedAgentId: string | undefined;
	private selectedIndex: number;

	constructor(
		agents: AgentSnapshot[],
		selectedAgentId: string | undefined,
		onSelect: (agentId: string) => void,
		onCancel: () => void,
		onInactiveSelect: (agent: AgentSnapshot) => void = () => {},
	) {
		this.agents = agents;
		this.onCancel = onCancel;
		this.onInactiveSelect = onInactiveSelect;
		this.onSelect = onSelect;
		this.selectedAgentId = selectedAgentId;

		const selectedAgentIndex = agents.findIndex(
			(agent) => agent.id === selectedAgentId && isActiveLifecycle(agent.lifecycle),
		);
		this.selectedIndex = selectedAgentIndex === -1 ? 0 : selectedAgentIndex + 1;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines = this.renderVisibleRows(width);
		const rowCount = this.agents.length + 1;
		if (rowCount > MAX_VISIBLE_AGENTS) {
			const scrollText = `  (${this.selectedIndex + 1}/${rowCount})`;
			lines.push(theme.fg("muted", truncateToWidth(scrollText, width, "")));
		}
		return lines;
	}

	private renderMainThreadLine(width: number, index: number): string {
		const isSelected = index === this.selectedIndex;
		const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
		const leftText = `${cursor}${theme.bold("Main thread")}`;
		const rightText = theme.fg("muted", "current");
		const spacing = Math.max(1, width - visibleWidth(leftText) - visibleWidth(rightText));
		let line = leftText + " ".repeat(spacing) + rightText;
		if (isSelected) {
			line = theme.bg("selectedBg", line);
		}
		return truncateToWidth(line, width, "");
	}

	private renderVisibleRows(width: number): string[] {
		const rowCount = this.agents.length + 1;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE_AGENTS / 2), rowCount - MAX_VISIBLE_AGENTS),
		);
		const endIndex = Math.min(startIndex + MAX_VISIBLE_AGENTS, rowCount);
		const lines: string[] = [];

		for (let index = startIndex; index < endIndex; index++) {
			if (index === 0) {
				lines.push(this.renderMainThreadLine(width, index));
				continue;
			}
			const agent = this.agents[index - 1];
			if (agent) {
				lines.push(this.renderAgentLine(agent, index, width));
			}
		}

		return lines;
	}

	private renderAgentLine(agent: AgentSnapshot, index: number, width: number): string {
		const isSelected = index === this.selectedIndex;
		const isCurrent = agent.id === this.selectedAgentId && isActiveLifecycle(agent.lifecycle);
		const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
		const slotLabel = agent.slot ? `#${agent.slot.index}` : "--";
		const rowLabel = `${index + 1}.`;
		const selectedMarker = isCurrent ? " selected" : "";
		const inactiveMarker = isActiveLifecycle(agent.lifecycle) ? "" : " inactive";
		const lifecycle = formatLifecycle(agent.lifecycle);
		const leftText = `${cursor}${theme.fg("muted", `${slotLabel} ${rowLabel} `)}${theme.bold(agent.displayName)}`;
		const idText = theme.fg("dim", ` ${formatAgentId(agent.id)}`);
		const rightText = theme.fg("muted", `${lifecycle}${inactiveMarker} ${agent.agentType}${selectedMarker}`);
		const leftWidth = visibleWidth(leftText) + visibleWidth(idText);
		const spacing = Math.max(1, width - leftWidth - visibleWidth(rightText));
		let line = leftText + idText + " ".repeat(spacing) + rightText;

		if (isSelected) {
			line = theme.bg("selectedBg", line);
		}

		return truncateToWidth(line, width, "");
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = Math.min(this.agents.length, this.selectedIndex + 1);
			return;
		}
		if (kb.matches(keyData, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - MAX_VISIBLE_AGENTS);
			return;
		}
		if (kb.matches(keyData, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(this.agents.length, this.selectedIndex + MAX_VISIBLE_AGENTS);
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			this.confirmSelection();
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
		}
	}

	private confirmSelection(): void {
		if (this.selectedIndex === 0) {
			this.onSelect(MAIN_THREAD_AGENT_ID);
			return;
		}
		const selected = this.agents[this.selectedIndex - 1];
		if (!selected) {
			return;
		}
		if (!isActiveLifecycle(selected.lifecycle)) {
			this.onInactiveSelect(selected);
			return;
		}
		this.onSelect(selected.id);
	}
}

export class AgentSwitcherComponent extends Container {
	private readonly list: AgentSwitcherList;

	constructor(
		agents: AgentSnapshot[],
		selectedAgentId: string | undefined,
		onSelect: (agentId: string) => void,
		onCancel: () => void,
		onInactiveSelect?: (agent: AgentSnapshot) => void,
	) {
		super();
		this.list = new AgentSwitcherList(agents, selectedAgentId, onSelect, onCancel, onInactiveSelect);

		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("  Agents")), 1, 0));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
	}

	handleInput(keyData: string): void {
		this.list.handleInput(keyData);
	}
}
