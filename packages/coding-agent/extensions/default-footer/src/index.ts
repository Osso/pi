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
import type { ReadonlySessionManager, SessionEntry } from "../../../src/core/session-manager.ts";
import type { Theme } from "../../../src/modes/interactive/theme/theme.ts";
import {
	formatExtensionStatusTextLines,
	sanitizeFooterStatusText,
} from "../../../src/utils/footer-status.ts";

const BACKGROUND_COMPACTION_STATUS_KEY = "background-compaction";
const BACKGROUND_COMPACTION_STATUS_TEXT = "compacting context";

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
	return sanitizeFooterStatusText(`selected${slot} ${agent.displayName} ${formatAgentLifecycle(agent.lifecycle)}`);
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

interface SessionUsage {
	input: number;
	output: number;
	cost: number;
}

/** Longest parent chain walked from the previous leaf before recounting every entry. */
const MAX_INCREMENTAL_USAGE_ENTRIES = 256;
const usageByLeaf = new WeakMap<ReadonlySessionManager, { leafId: string | null; usage: SessionUsage }>();

function addEntryUsage(usage: SessionUsage, entry: SessionEntry | undefined): SessionUsage {
	if (entry?.type !== "message" || entry.message.role !== "assistant") return usage;
	const message = entry.message as AssistantMessage;
	return {
		cost: usage.cost + message.usage.cost.total,
		input: usage.input + message.usage.input,
		output: usage.output + message.usage.output,
	};
}

/** Entries are append-only and new entries become the leaf, so usage since a cached leaf lies on the parent chain. */
function usageSinceLeaf(
	sessionManager: ReadonlySessionManager,
	fromLeafId: string | null,
	usage: SessionUsage,
): SessionUsage | undefined {
	let id = sessionManager.getLeafId();
	let total = usage;
	for (let walked = 0; walked < MAX_INCREMENTAL_USAGE_ENTRIES; walked += 1) {
		if (id === fromLeafId) return total;
		if (id === null) return undefined;
		const entry = sessionManager.getEntry(id);
		total = addEntryUsage(total, entry);
		id = entry?.parentId ?? null;
	}
	return undefined;
}

/** Extension session reads deep-copy entries, so avoid recounting the whole transcript on every render. */
function sessionUsage(session: FooterSessionOverride): SessionUsage {
	const sessionManager = session.sessionManager;
	if (!sessionManager) return { cost: 0, input: 0, output: 0 };
	const leafId = sessionManager.getLeafId();
	const cached = usageByLeaf.get(sessionManager);
	if (cached?.leafId === leafId) return cached.usage;
	const usage =
		(cached && usageSinceLeaf(sessionManager, cached.leafId, cached.usage)) ??
		sessionManager.getEntries().reduce(addEntryUsage, { cost: 0, input: 0, output: 0 });
	usageByLeaf.set(sessionManager, { leafId, usage });
	return usage;
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
	return formatExtensionStatusTextLines(input.footerData.getExtensionStatuses()).map((line) =>
		truncateToWidth(line, width, input.theme.fg("dim", "...")),
	);
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

function setBackgroundCompactionStatus(ctx: ExtensionContext, text: string | undefined): void {
	ctx.ui.setStatus(BACKGROUND_COMPACTION_STATUS_KEY, text);
	ctx.ui.requestRender();
}

function registerBackgroundCompactionStatus(pi: ExtensionAPI): void {
	pi.on("background_compaction_start", async (_event, ctx) => {
		setBackgroundCompactionStatus(ctx, BACKGROUND_COMPACTION_STATUS_TEXT);
	});

	pi.on("background_compaction_end", async (_event, ctx) => {
		setBackgroundCompactionStatus(ctx, undefined);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		setBackgroundCompactionStatus(ctx, undefined);
	});
}

export default function defaultFooterExtension(pi: ExtensionAPI, options: DefaultFooterExtensionOptions = {}) {
	const store = options.multiAgentStore;
	registerBackgroundCompactionStatus(pi);
	pi.on("session_start", async (_event, ctx) => {
		setBackgroundCompactionStatus(ctx, undefined);
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
