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

interface AgentSwitcherRow {
	agent: AgentSnapshot;
	treePrefix: string;
}

function formatLifecycle(lifecycle: AgentLifecycleState): string {
	return lifecycle.replace(/_/g, " ");
}

function formatAgentId(agentId: string): string {
	return agentId.length <= 12 ? agentId : `${agentId.slice(0, 11)}…`;
}

function buildAgentRows(agents: AgentSnapshot[]): AgentSwitcherRow[] {
	const visibleAgentIds = new Set(agents.map((agent) => agent.id));
	const childrenByParentId = new Map<string, AgentSnapshot[]>();
	const roots: AgentSnapshot[] = [];

	for (const agent of agents) {
		if (!agent.parentId || !visibleAgentIds.has(agent.parentId)) {
			roots.push(agent);
			continue;
		}
		const siblings = childrenByParentId.get(agent.parentId) ?? [];
		siblings.push(agent);
		childrenByParentId.set(agent.parentId, siblings);
	}

	const rows: AgentSwitcherRow[] = [];
	const appendAgent = (agent: AgentSnapshot, prefix: string, isLastSibling: boolean, isRoot: boolean): void => {
		const treePrefix = isRoot ? "" : `${prefix}${isLastSibling ? "└─ " : "├─ "}`;
		rows.push({ agent, treePrefix });
		const children = childrenByParentId.get(agent.id) ?? [];
		const childPrefix = isRoot ? "" : `${prefix}${isLastSibling ? "   " : "│  "}`;
		for (const [childIndex, child] of children.entries()) {
			appendAgent(child, childPrefix, childIndex === children.length - 1, false);
		}
	};

	for (const [rootIndex, root] of roots.entries()) {
		appendAgent(root, "", rootIndex === roots.length - 1, true);
	}

	return rows;
}

class AgentSwitcherList implements Component {
	private readonly allAgents: AgentSnapshot[];
	private readonly onCancel: () => void;
	private readonly onInactiveSelect: (agent: AgentSnapshot) => void;
	private readonly onSelect: (agentId: string) => void;
	private readonly selectedAgentId: string | undefined;
	private selectedIndex: number;
	private showClosedAgents = false;

	constructor(
		agents: AgentSnapshot[],
		selectedAgentId: string | undefined,
		onSelect: (agentId: string) => void,
		onCancel: () => void,
		onInactiveSelect: (agent: AgentSnapshot) => void = () => {},
	) {
		this.allAgents = agents;
		this.onCancel = onCancel;
		this.onInactiveSelect = onInactiveSelect;
		this.onSelect = onSelect;
		this.selectedAgentId = selectedAgentId;

		const selectedAgentIndex = this.agentRows.findIndex(
			(row) => row.agent.id === selectedAgentId && isActiveLifecycle(row.agent.lifecycle),
		);
		this.selectedIndex = selectedAgentIndex === -1 ? 0 : selectedAgentIndex + 1;
	}

	invalidate(): void {}

	private get agents(): AgentSnapshot[] {
		return this.showClosedAgents
			? this.allAgents
			: this.allAgents.filter((agent) => isActiveLifecycle(agent.lifecycle));
	}

	private get agentRows(): AgentSwitcherRow[] {
		return buildAgentRows(this.agents);
	}

	render(width: number): string[] {
		const lines = this.renderVisibleRows(width);
		const rowCount = this.agentRows.length + 1;
		if (rowCount > MAX_VISIBLE_AGENTS) {
			const scrollText = `  (${this.selectedIndex + 1}/${rowCount})`;
			lines.push(theme.fg("muted", truncateToWidth(scrollText, width, "")));
		}
		const hiddenCount = this.allAgents.filter((agent) => !isActiveLifecycle(agent.lifecycle)).length;
		if (hiddenCount > 0) {
			const status = this.showClosedAgents
				? `  Showing ${hiddenCount} closed agent${hiddenCount === 1 ? "" : "s"}`
				: `  ${hiddenCount} closed agent${hiddenCount === 1 ? "" : "s"} hidden`;
			lines.push(theme.fg("dim", truncateToWidth(status, width, "")));
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
		const rows = this.agentRows;
		const rowCount = rows.length + 1;
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
			const row = rows[index - 1];
			if (row) {
				lines.push(this.renderAgentLine(row, index, width));
			}
		}

		return lines;
	}

	private renderAgentLine(row: AgentSwitcherRow, index: number, width: number): string {
		const { agent, treePrefix } = row;
		const isSelected = index === this.selectedIndex;
		const isCurrent = agent.id === this.selectedAgentId && isActiveLifecycle(agent.lifecycle);
		const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
		const slotLabel = agent.slot ? `#${agent.slot.index}` : "--";
		const rowLabel = `${index + 1}.`;
		const selectedMarker = isCurrent ? " selected" : "";
		const inactiveMarker = isActiveLifecycle(agent.lifecycle) ? "" : " inactive";
		const lifecycle = formatLifecycle(agent.lifecycle);
		const leftText = `${cursor}${theme.fg("muted", `${treePrefix}${slotLabel} ${rowLabel} `)}${theme.bold(agent.displayName)}`;
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
			this.selectedIndex = Math.min(this.agentRows.length, this.selectedIndex + 1);
			return;
		}
		if (kb.matches(keyData, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - MAX_VISIBLE_AGENTS);
			return;
		}
		if (kb.matches(keyData, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(this.agentRows.length, this.selectedIndex + MAX_VISIBLE_AGENTS);
			return;
		}
		if (kb.matches(keyData, "app.agent.toggleClosed")) {
			this.showClosedAgents = !this.showClosedAgents;
			this.selectedIndex = Math.min(this.selectedIndex, this.agentRows.length);
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
		const selected = this.agentRows[this.selectedIndex - 1]?.agent;
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
					keyHint("app.agent.toggleClosed", "closed") +
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
