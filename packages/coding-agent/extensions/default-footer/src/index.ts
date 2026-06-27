import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../../src/core/footer-data-provider.ts";
import type { AgentLifecycleState, MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
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
	theme: Theme;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCost(cost: number, usingSubscription: boolean): string | undefined {
	if (!cost && !usingSubscription) {
		return undefined;
	}
	return `cost $${cost.toFixed(3)}${usingSubscription ? " sub" : ""}`;
}

function formatContextUsage(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const percent = usage?.percent;
	if (percent === null || percent === undefined) {
		return `ctx ?/${formatTokens(contextWindow)}`;
	}
	return `ctx ${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
}

function formatAgentCounts(counts: DefaultFooterAgentLifecycleCounts | undefined): string | undefined {
	if (!counts) {
		return undefined;
	}

	const parts = [];
	if (counts.running > 0) parts.push(`${counts.running} running`);
	if (counts.waitingForInput > 0) parts.push(`${counts.waitingForInput} waiting`);
	if (counts.steeringPending > 0) parts.push(`${counts.steeringPending} steering`);

	return parts.length > 0 ? `agents ${parts.join(" ")}` : undefined;
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

function sessionUsage(ctx: ExtensionContext): { input: number; output: number; cost: number } {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
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
	const usage = sessionUsage(input.ctx);
	const parts = [formatAgentCounts(input.getAgentCounts?.())];
	if (usage.input > 0) parts.push(`in ${formatTokens(usage.input)}`);
	if (usage.output > 0) parts.push(`out ${formatTokens(usage.output)}`);
	parts.push(formatCost(usage.cost, isUsingSubscription(input.ctx)));
	parts.push(formatContextUsage(input.ctx));

	return parts.filter((part): part is string => part !== undefined).join(" ");
}

function isUsingSubscription(ctx: ExtensionContext): boolean {
	return ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
}

function formatRightSide(input: DefaultFooterComponentInput): string {
	const modelName = input.ctx.model?.id || "no-model";
	if (input.footerData.getAvailableProviderCount() > 1 && input.ctx.model) {
		return `(${input.ctx.model.provider}) ${modelName}`;
	}
	return modelName;
}

function formatStatsLine(input: DefaultFooterComponentInput, width: number): string {
	let left = input.theme.fg("dim", formatStats(input));
	const right = input.theme.fg("dim", formatRightSide(input));
	if (visibleWidth(left) + 2 + visibleWidth(right) > width) {
		left = truncateToWidth(left, Math.max(0, width - visibleWidth(right) - 2), input.theme.fg("dim", "..."));
	}
	const padding = " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right)));
	return truncateToWidth(left + padding + right, width, input.theme.fg("dim", "..."));
}

function formatPwdLine(input: DefaultFooterComponentInput, width: number): string {
	let pwd = formatCwd(input.ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
	const branch = input.footerData.getGitBranch();
	if (branch) {
		pwd = `${pwd} (${branch})`;
	}
	const sessionName = input.ctx.sessionManager.getSessionName();
	if (sessionName) {
		pwd = `${pwd} • ${sessionName}`;
	}
	return truncateToWidth(input.theme.fg("dim", pwd), width, input.theme.fg("dim", "..."));
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
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setDefaultFooter((tui, thm, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			const component = createDefaultFooterComponent({
				ctx,
				footerData,
				getAgentCounts: options.multiAgentStore
					? () => countDefaultFooterAgents(options.multiAgentStore as MultiAgentStore)
					: undefined,
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
