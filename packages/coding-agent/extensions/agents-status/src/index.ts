import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import {
	type AgentLifecycleState,
	type AgentSnapshot,
	isActiveLifecycle,
	type MultiAgentStore,
} from "../../../src/core/multi-agent-store.ts";
import { formatElapsedDuration } from "../../../src/modes/interactive/components/elapsed-time.ts";
import type { Theme } from "../../../src/modes/interactive/theme/theme.ts";

const WIDGET_KEY = "agents-status";
export const MAX_AGENT_ROWS = 5;
const MAX_NAME_WIDTH = 24;
const TERMINAL_LINGER_MS = 10_000;
const REFRESH_INTERVAL_MS = 1000;

const LIFECYCLE_PRIORITY: Record<AgentLifecycleState, number> = {
	waiting_for_input: 0,
	steering_pending: 1,
	running: 2,
	cancelling: 3,
	failed: 4,
	aborted: 5,
	completed: 6,
};

interface AgentRow {
	agent: AgentSnapshot;
	depth: number;
}

interface AgentsStatusExtensionOptions {
	store?: MultiAgentStore;
}

function isVisible(agent: AgentSnapshot, nowMs: number): boolean {
	if (isActiveLifecycle(agent.lifecycle)) return true;
	return nowMs - Date.parse(agent.updatedAt) < TERMINAL_LINGER_MS;
}

function compareAgents(left: AgentSnapshot, right: AgentSnapshot): number {
	const byLifecycle = LIFECYCLE_PRIORITY[left.lifecycle] - LIFECYCLE_PRIORITY[right.lifecycle];
	return byLifecycle !== 0 ? byLifecycle : right.updatedAt.localeCompare(left.updatedAt);
}

/** Visible agents in tree order: siblings sorted by urgency, children directly under their parent. */
export function collectAgentRows(agents: AgentSnapshot[], nowMs: number): AgentRow[] {
	const visible = agents.filter((agent) => isVisible(agent, nowMs));
	const visibleIds = new Set(visible.map((agent) => agent.id));
	const childrenByParent = new Map<string | undefined, AgentSnapshot[]>();
	for (const agent of visible) {
		const parentKey = agent.parentId && visibleIds.has(agent.parentId) ? agent.parentId : undefined;
		childrenByParent.set(parentKey, [...(childrenByParent.get(parentKey) ?? []), agent]);
	}
	const rows: AgentRow[] = [];
	const appendChildren = (parentKey: string | undefined, depth: number) => {
		for (const agent of (childrenByParent.get(parentKey) ?? []).sort(compareAgents)) {
			rows.push({ agent, depth });
			appendChildren(agent.id, depth + 1);
		}
	};
	appendChildren(undefined, 0);
	return rows;
}

function describeActivity(agent: AgentSnapshot): string {
	switch (agent.lifecycle) {
		case "running":
		case "steering_pending": {
			const activity = agent.currentActivity;
			if (activity?.phase === "tool") {
				return activity.detail ? `${activity.toolName} ${activity.detail}` : activity.toolName;
			}
			if (activity?.phase === "thinking") return "thinking";
			return agent.lifecycle === "steering_pending" ? "steering pending" : "starting";
		}
		case "waiting_for_input":
			return "waiting for input";
		case "cancelling":
			return "cancelling";
		case "completed":
			return "done";
		case "failed":
			return agent.error?.message ? `failed: ${agent.error.message}` : "failed";
		case "aborted":
			return "aborted";
	}
}

function elapsedMs(agent: AgentSnapshot, nowMs: number): number {
	if (!isActiveLifecycle(agent.lifecycle)) return Date.parse(agent.updatedAt) - Date.parse(agent.createdAt);
	const startedAt = agent.currentActivity?.startedAt ?? agent.createdAt;
	return nowMs - Date.parse(startedAt);
}

function lifecycleIcon(lifecycle: AgentLifecycleState, theme: Theme): string {
	switch (lifecycle) {
		case "running":
			return theme.fg("accent", "●");
		case "waiting_for_input":
		case "steering_pending":
			return theme.fg("warning", "◐");
		case "cancelling":
		case "aborted":
			return theme.fg("muted", "○");
		case "completed":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
	}
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function renderAgentRow(row: AgentRow, nameWidth: number, width: number, nowMs: number, theme: Theme): string {
	const indent = row.depth > 0 ? `${"  ".repeat(row.depth - 1)}└ ` : "";
	const name = truncateToWidth(singleLine(row.agent.displayName), nameWidth, "…");
	const namePadding = " ".repeat(nameWidth - visibleWidth(name));
	const left = ` ${indent}${lifecycleIcon(row.agent.lifecycle, theme)} ${name}${namePadding}  `;
	const elapsed = theme.fg("dim", formatElapsedDuration(elapsedMs(row.agent, nowMs)));
	const activityWidth = Math.max(0, width - visibleWidth(left) - visibleWidth(elapsed) - 2);
	const activity = truncateToWidth(singleLine(describeActivity(row.agent)), activityWidth, "…");
	const padding = " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(activity) - visibleWidth(elapsed)));
	return truncateToWidth(`${left}${theme.fg("muted", activity)}${padding}${elapsed}`, width, "…");
}

export function renderAgentsStatus(agents: AgentSnapshot[], width: number, nowMs: number, theme: Theme): string[] {
	const rows = collectAgentRows(agents, nowMs);
	if (rows.length === 0) return [];
	const shown = rows.slice(0, MAX_AGENT_ROWS);
	const longestName = Math.max(...shown.map((row) => visibleWidth(singleLine(row.agent.displayName))));
	const nameWidth = Math.min(MAX_NAME_WIDTH, longestName);
	const lines = shown.map((row) => renderAgentRow(row, nameWidth, width, nowMs, theme));
	if (rows.length > shown.length) {
		lines.push(truncateToWidth(theme.fg("dim", ` +${rows.length - shown.length} more`), width, "…"));
	}
	return lines;
}

/** Redraws only the widget's own lines; the TUI falls back to a full render when the row count changes. */
export function createAgentsStatusComponent(
	store: MultiAgentStore,
	tui: Pick<TUI, "requestComponentRender">,
	theme: Theme,
): Component & { dispose(): void } {
	let hadRows = false;
	const component: Component & { dispose(): void } = {
		dispose() {
			clearInterval(timer);
			unsubscribe();
		},
		invalidate() {},
		render(width: number): string[] {
			return renderAgentsStatus(store.listAgents(), width, Date.now(), theme);
		},
	};
	const requestRenderWhileVisible = () => {
		const hasRows = collectAgentRows(store.listAgents(), Date.now()).length > 0;
		if (hasRows || hadRows) tui.requestComponentRender(component);
		hadRows = hasRows;
	};
	const unsubscribe = store.subscribeAgentUpdates(requestRenderWhileVisible);
	const timer = setInterval(requestRenderWhileVisible, REFRESH_INTERVAL_MS);
	timer.unref();
	return component;
}

export default function agentsStatusExtension(pi: ExtensionAPI, options: AgentsStatusExtensionOptions = {}) {
	const store = options.store;
	if (!store) return;
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) =>
			createAgentsStatusComponent(store, tui, theme),
		);
	});
}
