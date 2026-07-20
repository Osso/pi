import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import type {
	FooterSessionOverride,
	ReadonlyFooterDataProvider,
} from "../../../src/core/footer-data-provider.ts";
import {
	type AgentLifecycleState,
	type AgentSnapshot,
	isActiveLifecycle,
	type MultiAgentStore,
} from "../../../src/core/multi-agent-store.ts";
import type { Theme } from "../../../src/modes/interactive/theme/theme.ts";

export interface DefaultFooterAgentLifecycleCounts {
	running: number;
	waitingForInput: number;
	steeringPending: number;
}

export interface DefaultFooterExtensionOptions {
	multiAgentStore?: MultiAgentStore;
}

export interface DefaultFooterComponentInput {
	ctx: ExtensionContext;
	footerData: ReadonlyFooterDataProvider;
	getAgentCounts?: () => DefaultFooterAgentLifecycleCounts | undefined;
	getSelectedAgent?: () => DefaultFooterSelectedAgent | undefined;
	theme: Theme;
}

export interface DefaultFooterSelectedAgent {
	displayName: string;
	lifecycle: AgentLifecycleState;
	slotIndex?: number;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCost(cost: number): string | undefined {
	if (!cost) {
		return undefined;
	}
	return `cost $${cost.toFixed(2)}`;
}

function footerSession(input: DefaultFooterComponentInput): FooterSessionOverride {
	return (
		input.footerData.getSessionOverride() ?? {
			cwd: input.ctx.sessionManager.getCwd(),
			sessionManager: input.ctx.sessionManager,
			model: input.ctx.model ?? null,
			thinkingLevel: input.ctx.getThinkingLevel?.() ?? "off",
			contextUsage: input.ctx.getContextUsage(),
		}
	);
}

function formatContextUsage(session: FooterSessionOverride, theme: Theme): string {
	const usage = session.contextUsage;
	const contextWindow = usage?.contextWindow ?? session.model?.contextWindow ?? 0;
	const contextWindowText = formatTokens(contextWindow);
	const percent = usage?.percent;
	if (percent === null || percent === undefined) {
		return theme.fg("dim", `ctx ?/${contextWindowText}`);
	}
	return `${theme.fg("dim", "ctx ")}${percent.toFixed(1)}%${theme.fg("dim", `/${contextWindowText}`)}`;
}

function formatAgentCounts(counts: DefaultFooterAgentLifecycleCounts | undefined): string | undefined {
	if (!counts) {
		return undefined;
	}

	const activeCount = counts.running + counts.waitingForInput + counts.steeringPending;
	return activeCount > 0 ? `agents ${activeCount}` : undefined;
}

function formatAgentLifecycle(lifecycle: AgentLifecycleState): string {
	return lifecycle.replace(/_/g, " ");
}

function formatSelectedAgent(agent: DefaultFooterSelectedAgent | undefined): string | undefined {
	if (!agent) {
		return undefined;
	}

	const slot = agent.slotIndex === undefined ? "" : ` #${agent.slotIndex}`;
	return sanitizeStatusText(`selected${slot} ${agent.displayName} ${formatAgentLifecycle(agent.lifecycle)}`);
}

function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function countMatchingLifecycle(
	counts: DefaultFooterAgentLifecycleCounts,
	lifecycle: AgentLifecycleState,
): DefaultFooterAgentLifecycleCounts {
	if (lifecycle === "running") {
		return { ...counts, running: counts.running + 1 };
	}
	if (lifecycle === "waiting_for_input") {
		return { ...counts, waitingForInput: counts.waitingForInput + 1 };
	}
	if (lifecycle === "steering_pending") {
		return { ...counts, steeringPending: counts.steeringPending + 1 };
	}
	return counts;
}

export function countDefaultFooterAgents(store: MultiAgentStore): DefaultFooterAgentLifecycleCounts {
	let counts: DefaultFooterAgentLifecycleCounts = {
		running: 0,
		steeringPending: 0,
		waitingForInput: 0,
	};
	for (const agent of store.listAgents()) {
		counts = countMatchingLifecycle(counts, agent.lifecycle);
	}
	return counts;
}

function sessionUsage(session: FooterSessionOverride): { input: number; output: number; cost: number } {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const entry of session.sessionManager?.getEntries() ?? []) {
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			continue;
		}
		const message = entry.message as AssistantMessage;
		input += message.usage.input;
		output += message.usage.output;
		cost += message.usage.cost.total;
	}
	return { cost, input, output };
}

function formatStats(input: DefaultFooterComponentInput): string {
	const session = footerSession(input);
	const usage = sessionUsage(session);
	const executableName = input.footerData.getExecutableName();
	const selectedAgent = formatSelectedAgent(input.getSelectedAgent?.());
	const parts = [
		executableName ? input.theme.fg("dim", `[${executableName}]`) : undefined,
		selectedAgent ? input.theme.fg("dim", selectedAgent) : undefined,
		formatAgentCounts(input.getAgentCounts?.()),
	];
	if (usage.input > 0) parts.push(input.theme.fg("dim", `in ${formatTokens(usage.input)}`));
	if (usage.output > 0) parts.push(input.theme.fg("dim", `out ${formatTokens(usage.output)}`));
	const cost = formatCost(usage.cost);
	if (cost) parts.push(input.theme.fg("dim", cost));
	parts.push(formatContextUsage(session, input.theme));

	return parts.filter((part): part is string => part !== undefined).join(" ");
}

function formatRightSide(input: DefaultFooterComponentInput): string {
	const session = footerSession(input);
	const modelName = session.model?.id || "no-model";
	const effortSuffix = session.model?.reasoning ? ` • effort ${session.thinkingLevel}` : "";
	if (input.footerData.getAvailableProviderCount() > 1 && session.model) {
		return `(${session.model.provider}) ${modelName}${effortSuffix}`;
	}
	return `${modelName}${effortSuffix}`;
}

function formatStatsLine(input: DefaultFooterComponentInput, width: number): string {
	let left = formatStats(input);
	const right = input.theme.fg("dim", formatRightSide(input));
	if (visibleWidth(left) + 2 + visibleWidth(right) > width) {
		left = truncateToWidth(left, Math.max(0, width - visibleWidth(right) - 2), input.theme.fg("dim", "..."));
	}
	const padding = " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right)));
	return truncateToWidth(left + padding + right, width, input.theme.fg("dim", "..."));
}

function formatPwdLine(input: DefaultFooterComponentInput, width: number): string {
	const session = footerSession(input);
	const sessionManager = session.sessionManager;
	let pwd = formatCwd(session.cwd, process.env.HOME || process.env.USERPROFILE);
	const branch = input.footerData.getSessionOverride() ? null : input.footerData.getGitBranch();
	if (branch) {
		pwd = `${pwd} (${branch})`;
	}
	const sessionName = sessionManager?.getSessionName();
	if (sessionName) {
		pwd = `${pwd} • ${sessionName}`;
	}
	return truncateToWidth(input.theme.fg("dim", pwd), width, input.theme.fg("dim", "..."));
}

function selectedAgentForFooter(store: MultiAgentStore): DefaultFooterSelectedAgent | undefined {
	const selectedAgentId = store.getSelectedAgentId();
	const selectedAgent = selectedAgentId ? store.getAgent(selectedAgentId) : undefined;
	if (!selectedAgent || !isActiveLifecycle(selectedAgent.lifecycle)) {
		return undefined;
	}

	return {
		displayName: selectedAgent.displayName,
		lifecycle: selectedAgent.lifecycle,
		slotIndex: selectedAgentSlotIndex(store, selectedAgent),
	};
}

function selectedAgentSlotIndex(store: MultiAgentStore, selectedAgent: AgentSnapshot): number | undefined {
	if (selectedAgent.slot?.index !== undefined) {
		return selectedAgent.slot.index;
	}

	const agentIndex = store.listAgents().findIndex((agent) => agent.id === selectedAgent.id);
	return agentIndex === -1 ? undefined : agentIndex + 1;
}

function extensionStatusLines(input: DefaultFooterComponentInput, width: number): string[] {
	const statuses = input.footerData.getExtensionStatuses();
	if (statuses.size === 0) {
		return [];
	}
	const statusLine = Array.from(statuses.entries())
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, text]) => sanitizeStatusText(text))
		.join(" ");
	return [truncateToWidth(statusLine, width, input.theme.fg("dim", "..."))];
}

export function createDefaultFooterComponent(input: DefaultFooterComponentInput): Component & { dispose?(): void } {
	return {
		dispose: input.footerData.onBranchChange(() => {}),
		invalidate() {},
		render(width: number): string[] {
			return [formatPwdLine(input, width), formatStatsLine(input, width), ...extensionStatusLines(input, width)];
		},
	};
}

export default function defaultFooterExtension(pi: ExtensionAPI, options: DefaultFooterExtensionOptions = {}) {
	const store = options.multiAgentStore;
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setDefaultFooter((tui, thm, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			const component = createDefaultFooterComponent({
				ctx,
				footerData,
				getAgentCounts: store ? () => countDefaultFooterAgents(store) : undefined,
				getSelectedAgent: store ? () => selectedAgentForFooter(store) : undefined,
				theme: thm,
			});
			return {
				dispose: () => {
					component.dispose?.();
					unsubscribe();
				},
				invalidate: () => component.invalidate(),
				render: (width) => component.render(width),
			};
		});
	});
}
