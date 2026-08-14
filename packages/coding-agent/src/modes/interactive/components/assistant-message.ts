import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

type ContentSlot = {
	contentType: AssistantMessage["content"][number]["type"];
	component?: Markdown | Text;
	trailingSpacer?: Spacer;
	componentText: string;
	visible: boolean;
	hiddenThinking: boolean;
};

type TrailingStatusSlot = {
	spacer: Spacer;
	text: Text;
	message: string;
};

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private contentSlots: ContentSlot[] = [];
	private leadingSpacer?: Spacer;
	private trailingStatusSlot?: TrailingStatusSlot;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;
		this.contentSlots = message.content.map((content, contentIndex) =>
			this.reconcileContentSlot(this.contentSlots[contentIndex], content),
		);
		this.updateThinkingSpacers();

		this.hasToolCalls = message.content.some((content) => content.type === "toolCall");
		this.trailingStatusSlot = this.reconcileTrailingStatus(message, this.hasToolCalls);
		this.rebuildContentChildren();
	}

	private reconcileContentSlot(
		existing: ContentSlot | undefined,
		content: AssistantMessage["content"][number],
	): ContentSlot {
		if (content.type === "text") {
			return this.reconcileTextSlot(existing, content.text.trim());
		}

		if (content.type === "thinking") {
			return this.reconcileThinkingSlot(existing, content.thinking.trim());
		}

		return {
			contentType: "toolCall",
			componentText: "",
			visible: false,
			hiddenThinking: false,
		};
	}

	private reconcileTextSlot(existing: ContentSlot | undefined, text: string): ContentSlot {
		const markdown =
			existing?.contentType === "text" && existing.component instanceof Markdown
				? existing.component
				: text
					? new Markdown(text, this.outputPad, 0, this.markdownTheme)
					: undefined;

		if (markdown) {
			markdown.setPadding(this.outputPad, 0);
			if (existing?.componentText !== text) {
				markdown.setText(text);
			}
		}

		return {
			contentType: "text",
			component: markdown,
			componentText: text,
			visible: text.length > 0,
			hiddenThinking: false,
		};
	}

	private reconcileThinkingSlot(existing: ContentSlot | undefined, text: string): ContentSlot {
		if (this.hideThinkingBlock) {
			return this.reconcileHiddenThinkingSlot(existing, text);
		}

		return this.reconcileVisibleThinkingSlot(existing, text);
	}

	private reconcileHiddenThinkingSlot(existing: ContentSlot | undefined, text: string): ContentSlot {
		const label = theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel));
		const existingText =
			existing?.contentType === "thinking" && existing.hiddenThinking && existing.component instanceof Text
				? existing.component
				: undefined;
		const hiddenText = existingText ?? (text ? new Text(label, this.outputPad, 0) : undefined);

		if (hiddenText) {
			hiddenText.setPadding(this.outputPad, 0);
			if (existing?.componentText !== label) {
				hiddenText.setText(label);
			}
		}

		return {
			contentType: "thinking",
			component: hiddenText,
			trailingSpacer: existing?.contentType === "thinking" ? existing.trailingSpacer : undefined,
			componentText: label,
			visible: text.length > 0,
			hiddenThinking: true,
		};
	}

	private reconcileVisibleThinkingSlot(existing: ContentSlot | undefined, text: string): ContentSlot {
		const existingMarkdown =
			existing?.contentType === "thinking" && !existing.hiddenThinking && existing.component instanceof Markdown
				? existing.component
				: undefined;
		const markdown =
			existingMarkdown ??
			(text
				? new Markdown(text, this.outputPad, 0, this.markdownTheme, {
						color: (value: string) => theme.fg("thinkingText", value),
						italic: true,
					})
				: undefined);

		if (markdown) {
			markdown.setPadding(this.outputPad, 0);
			if (existing?.componentText !== text) {
				markdown.setText(text);
			}
		}

		return {
			contentType: "thinking",
			component: markdown,
			trailingSpacer: existing?.contentType === "thinking" ? existing.trailingSpacer : undefined,
			componentText: text,
			visible: text.length > 0,
			hiddenThinking: false,
		};
	}

	private updateThinkingSpacers(): void {
		let hasVisibleContentAfter = false;
		for (let i = this.contentSlots.length - 1; i >= 0; i--) {
			const slot = this.contentSlots[i];
			if (!slot) {
				continue;
			}

			const needsTrailingSpacer = slot.contentType === "thinking" && slot.visible && hasVisibleContentAfter;
			if (needsTrailingSpacer) {
				slot.trailingSpacer ??= new Spacer(1);
			} else {
				slot.trailingSpacer = undefined;
			}

			if (slot.visible) {
				hasVisibleContentAfter = true;
			}
		}
	}

	private reconcileTrailingStatus(message: AssistantMessage, hasToolCalls: boolean): TrailingStatusSlot | undefined {
		const statusMessage = this.getStatusMessage(message, hasToolCalls);
		if (!statusMessage) {
			return undefined;
		}

		if (this.trailingStatusSlot) {
			this.trailingStatusSlot.text.setPadding(this.outputPad, 0);
			if (this.trailingStatusSlot.message !== statusMessage) {
				this.trailingStatusSlot.text.setText(statusMessage);
				this.trailingStatusSlot.message = statusMessage;
			}
			return this.trailingStatusSlot;
		}

		return {
			spacer: new Spacer(1),
			text: new Text(statusMessage, this.outputPad, 0),
			message: statusMessage,
		};
	}

	private getStatusMessage(message: AssistantMessage, hasToolCalls: boolean): string | undefined {
		if (message.stopReason === "length") {
			return theme.fg(
				"error",
				"Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
			);
		}

		if (hasToolCalls) {
			return undefined;
		}

		if (message.stopReason === "aborted") {
			const abortMessage =
				message.errorMessage && message.errorMessage !== "Request was aborted"
					? message.errorMessage
					: "Operation aborted";
			return theme.fg("error", abortMessage);
		}

		if (message.stopReason === "error") {
			return theme.fg("error", `Error: ${message.errorMessage || "Unknown error"}`);
		}

		return undefined;
	}

	private rebuildContentChildren(): void {
		const children: Component[] = [];
		const hasVisibleContent = this.contentSlots.some((slot) => slot.visible);
		if (hasVisibleContent) {
			this.leadingSpacer ??= new Spacer(1);
			children.push(this.leadingSpacer);
		}

		for (const slot of this.contentSlots) {
			if (!slot.visible || !slot.component) {
				continue;
			}

			children.push(slot.component);
			if (slot.trailingSpacer) {
				children.push(slot.trailingSpacer);
			}
		}

		if (this.trailingStatusSlot) {
			children.push(this.trailingStatusSlot.spacer, this.trailingStatusSlot.text);
		}

		this.contentContainer.children = children;
	}
}
