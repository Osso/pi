import { Box, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Component that renders a compaction message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class CompactionSummaryMessageComponent extends Box {
	private expanded = false;
	private message: CompactionSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(message: CompactionSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		const tokenSummary = formatCompactionTokenSummary(this.message);
		const durationText = formatCompactionDuration(this.message.durationMs);
		const durationSuffix = durationText ? ` in ${durationText}` : "";
		const remoteResultSuffix = formatRemoteResultSuffix(this.message.compactedResultTokens);
		const label = theme.fg("customMessageLabel", `\x1b[1m[compaction]\x1b[22m`);
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));

		if (this.expanded) {
			const header = `**${tokenSummary}${remoteResultSuffix}${durationSuffix}**\n\n`;
			this.addChild(
				new Markdown(header + this.message.summary, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			this.addChild(
				new Text(
					theme.fg("customMessageText", `${tokenSummary}${remoteResultSuffix}${durationSuffix} (`) +
						theme.fg("dim", keyText("app.tools.expand")) +
						theme.fg("customMessageText", " to expand)"),
					0,
					0,
				),
			);
		}
	}
}

function formatCompactionTokenSummary(message: CompactionSummaryMessage): string {
	const tokensBefore = message.tokensBefore.toLocaleString();
	if (message.tokensAfter === undefined) return `Compacted from ${tokensBefore} tokens`;

	const tokensAfter = message.tokensAfter.toLocaleString();
	const savedTokens = Math.max(0, message.tokensBefore - message.tokensAfter).toLocaleString();
	return `Compacted from ${tokensBefore} to ${tokensAfter} tokens; saved ${savedTokens}`;
}

function formatRemoteResultSuffix(compactedResultTokens: number | undefined): string {
	if (compactedResultTokens === undefined) return "";
	return `; remote result ${compactedResultTokens.toLocaleString()} tokens`;
}

function formatCompactionDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	if (durationMs < 1000) return `${durationMs}ms`;
	return `${(durationMs / 1000).toFixed(1)}s`;
}
