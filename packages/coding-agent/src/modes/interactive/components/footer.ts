import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ContextUsage } from "../../../core/extensions/types.ts";
import type { FooterSessionOverride, ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

type SessionFooterData = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
	contextUsage: ContextUsage | undefined;
	sessionName: string | undefined;
};

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
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

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private cachedSessionData: SessionFooterData | undefined;
	private sessionOverride: FooterSessionOverride | undefined;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
		this.cachedSessionData = undefined;
		this.clearSessionOverride();
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	setSessionOverride(override: FooterSessionOverride): void {
		this.sessionOverride = override;
		this.cachedSessionData = undefined;
	}

	clearSessionOverride(): void {
		this.sessionOverride = undefined;
		this.cachedSessionData = undefined;
	}

	/** Clear cached footer data after session data changes. */
	invalidate(): void {
		this.cachedSessionData = undefined;
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	private getSessionData(): SessionFooterData {
		if (this.cachedSessionData) {
			return this.cachedSessionData;
		}

		const sessionManager = this.sessionOverride ? this.sessionOverride.sessionManager : this.session.sessionManager;
		const data: SessionFooterData = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			latestCacheHitRate: undefined,
			contextUsage: this.sessionOverride ? this.sessionOverride.contextUsage : this.session.getContextUsage(),
			sessionName: sessionManager?.getSessionName(),
		};
		for (const entry of sessionManager?.getEntries() ?? []) {
			if (entry.type !== "message" || entry.message.role !== "assistant") {
				continue;
			}
			data.input += entry.message.usage.input;
			data.output += entry.message.usage.output;
			data.cacheRead += entry.message.usage.cacheRead;
			data.cacheWrite += entry.message.usage.cacheWrite;
			data.cost += entry.message.usage.cost.total;

			const latestPromptTokens =
				entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
			data.latestCacheHitRate =
				latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
		}
		this.cachedSessionData = data;
		return data;
	}

	render(width: number): string[] {
		const state = this.session.state;
		const displayedModel = this.sessionOverride === undefined ? state.model : this.sessionOverride.model;
		const displayedThinkingLevel = this.sessionOverride?.thinkingLevel ?? state.thinkingLevel;
		const sessionData = this.getSessionData();

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = sessionData.contextUsage;
		const contextWindow =
			contextUsage?.contextWindow ??
			displayedModel?.contextWindow ??
			(this.sessionOverride ? 0 : (state.model?.contextWindow ?? 0));
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent == null ? "?" : contextUsage.percent.toFixed(1);

		// Replace home directory with ~
		const cwd = this.sessionOverride?.cwd ?? this.session.sessionManager.getCwd();
		let pwd = formatCwdForFooter(cwd, process.env.HOME || process.env.USERPROFILE);

		// The shared provider watches the main session repository. Omit its branch in child views.
		const branch = this.sessionOverride ? null : this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Add session name if set
		const sessionName = sessionData.sessionName;
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}

		// Build stats line
		const statsParts = [];
		const executableName = this.footerData.getExecutableName();
		if (executableName) statsParts.push(`[${executableName}]`);
		if (sessionData.input) statsParts.push(`↑${formatTokens(sessionData.input)}`);
		if (sessionData.output) statsParts.push(`↓${formatTokens(sessionData.output)}`);
		if (sessionData.cacheRead) statsParts.push(`R${formatTokens(sessionData.cacheRead)}`);
		if (sessionData.cacheWrite) statsParts.push(`W${formatTokens(sessionData.cacheWrite)}`);
		if ((sessionData.cacheRead > 0 || sessionData.cacheWrite > 0) && sessionData.latestCacheHitRate !== undefined) {
			statsParts.push(`CH${sessionData.latestCacheHitRate.toFixed(1)}%`);
		}

		// Show cost with "(sub)" indicator if using OAuth subscription
		const usingSubscription = displayedModel ? this.session.modelRegistry.isUsingOAuth(displayedModel) : false;
		if (sessionData.cost || usingSubscription) {
			const costStr = `$${sessionData.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			statsParts.push(costStr);
		}

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);
		if (areExperimentalFeaturesEnabled()) {
			statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
		}

		let statsLeft = statsParts.join(" ");

		// Add model name on the right side, plus thinking level if model supports it
		const modelName = displayedModel?.id || "no-model";

		let statsLeftWidth = visibleWidth(statsLeft);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;

		// Add effort indicator if model supports reasoning
		let rightSideWithoutProvider = modelName;
		if (displayedModel?.reasoning) {
			const effortLevel = displayedThinkingLevel ?? "off";
			rightSideWithoutProvider = `${modelName} • effort ${effortLevel}`;
		}

		// Prepend the provider in parentheses if there are multiple providers and there's enough room
		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && displayedModel) {
			rightSide = `(${displayedModel.provider}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				// Too wide, fall back
				rightSide = rightSideWithoutProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				// Not enough space for right side at all
				statsLine = statsLeft;
			}
		}

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
		const dimRemainder = theme.fg("dim", remainder);

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, dimStatsLeft + dimRemainder];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
