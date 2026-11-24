import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput, sanitizeToolDisplayText } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { formatElapsedDuration } from "./elapsed-time.ts";

const MAX_TOOL_OUTPUT_LINES = 100;

type ToolResultContentItem = {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
};

function limitToolOutputLines(lines: string[]): string[] {
	if (lines.length <= MAX_TOOL_OUTPUT_LINES) {
		return lines;
	}
	const headLineCount = MAX_TOOL_OUTPUT_LINES / 2;
	const tailLineCount = MAX_TOOL_OUTPUT_LINES - headLineCount;
	const hiddenLineCount = lines.length - MAX_TOOL_OUTPUT_LINES;
	return [
		...lines.slice(0, headLineCount),
		`... (${hiddenLineCount} more lines hidden)`,
		...lines.slice(-tailLineCount),
	];
}

function limitToolResultContent(content: ToolResultContentItem[]): ToolResultContentItem[] {
	const textBlockIndexes = content.flatMap((item, index) => (item.type === "text" ? [index] : []));
	if (textBlockIndexes.length === 0) {
		return content;
	}
	const output = textBlockIndexes.map((index) => content[index]?.text ?? "").join("\n");
	// A final newline terminates the last line; it does not start another one.
	const finalNewline = output.endsWith("\n") ? "\n" : "";
	const outputLines = (finalNewline ? output.slice(0, -1) : output).split("\n");
	if (outputLines.length <= MAX_TOOL_OUTPUT_LINES) {
		return content;
	}
	const limitedText = limitToolOutputLines(outputLines).join("\n") + finalNewline;
	const firstTextBlockIndex = textBlockIndexes[0];
	return content.flatMap((item, index) => {
		if (item.type !== "text") {
			return [item];
		}
		return index === firstTextBlockIndex ? [{ ...item, text: limitedText }] : [];
	});
}

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	hideOutput?: boolean;
}

export interface ToolExecutionStartOptions {
	showLiveElapsed?: boolean;
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	/** Last component the result renderer itself returned; a fallback shown after it throws is never passed back. */
	private resultRendererLastComponent?: Component;
	private rendererState: Record<string, unknown> = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	/** The model chooses the tool name, so it is shown without terminal controls. */
	private toolTitle: string;
	private toolCallId: string;
	private args: unknown;
	private expanded = false;
	private showImages: boolean;
	private hideOutput: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition;
	private builtInToolDefinition?: ToolDefinition;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private showLiveElapsed = false;
	private executionStartedAt: number | undefined;
	private executionFinishedAt: number | undefined;
	private argsComplete = false;
	private result?: {
		content: Array<{
			type: string;
			text?: string;
			data?: string;
			mimeType?: string;
		}>;
		isError: boolean;
		details?: unknown;
	};
	private convertedImages = new Map<
		number,
		{ sourceData: string; sourceMimeType: string; data: string; mimeType: string }
	>();
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolTitle = sanitizeToolDisplayText(toolName);
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.hideOutput = options.hideOutput ?? false;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 0, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 0, (text: string) => theme.bg("toolPendingBg", text));
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolTitle)), 0, 0);
	}

	private createTimerComponent(): Component | undefined {
		const timingText = [this.formatTimerText(), this.formatCompletionTime()].filter(Boolean).join(" ");
		if (!timingText) {
			return undefined;
		}
		return new Text(theme.fg("muted", timingText), 0, 0);
	}

	private formatTimerText(): string | undefined {
		if (this.executionStartedAt === undefined) {
			return undefined;
		}

		const liveFinishedAt = this.isPartial && (this.result || this.showLiveElapsed) ? Date.now() : undefined;
		const finishedAt = this.executionFinishedAt ?? liveFinishedAt;
		if (finishedAt === undefined) {
			return undefined;
		}

		const elapsedMs = finishedAt - this.executionStartedAt;
		return `Elapsed: ${formatElapsedDuration(elapsedMs)}`;
	}

	private formatCompletionTime(): string | undefined {
		if (this.executionFinishedAt === undefined) {
			return undefined;
		}
		return new Date(this.executionFinishedAt).toLocaleTimeString("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		});
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput(this.getDisplayContent());
		if (!output) {
			return undefined;
		}
		return new Text(theme.fg("toolOutput", output), 0, 0);
	}

	updateArgs(args: unknown): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(startedAt: number, options: ToolExecutionStartOptions = {}): void {
		this.executionStarted = true;
		this.showLiveElapsed = options.showLiveElapsed ?? false;
		this.executionStartedAt = startedAt;
		this.executionFinishedAt = undefined;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{
				type: string;
				text?: string;
				data?: string;
				mimeType?: string;
			}>;
			details?: unknown;
			isError: boolean;
		},
		isPartial = false,
		finishedAt?: number,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		if (!isPartial) {
			this.executionFinishedAt = finishedAt ?? Date.now();
		}
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (const [i, img] of imageBlocks.entries()) {
			if (!img.data || !img.mimeType) continue;
			const sourceData = img.data;
			const sourceMimeType = img.mimeType;
			if (sourceMimeType === "image/png") continue;
			const cached = this.convertedImages.get(i);
			if (cached?.sourceData === sourceData && cached.sourceMimeType === sourceMimeType) continue;

			const index = i;
			convertToPng(sourceData, sourceMimeType).then((converted) => {
				// Ignore conversions that finish after the image was replaced (#8577).
				const currentImage = this.result?.content.filter((content) => content.type === "image")[index];
				if (!converted || currentImage?.data !== sourceData || currentImage.mimeType !== sourceMimeType) return;
				this.convertedImages.set(index, { sourceData, sourceMimeType, ...converted });
				this.updateDisplay();
				this.ui.requestRender();
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setHideOutput(hide: boolean): void {
		this.hideOutput = hide;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private renderSelfTimer(width: number): string[] {
		return this.createTimerComponent()?.render(width) ?? [];
	}

	private renderSelfShell(width: number): string[] {
		const contentLines = this.selfRenderContainer.render(width);
		if (contentLines.length === 0 && this.imageComponents.length === 0) {
			return [];
		}

		const lines = contentLines.length > 0 ? ["", ...contentLines, ...this.renderSelfTimer(width)] : [];
		for (let i = 0; i < this.imageComponents.length; i++) {
			const spacer = this.imageSpacers[i];
			if (spacer) {
				lines.push(...spacer.render(width));
			}
			const imageComponent = this.imageComponents[i];
			if (imageComponent) {
				lines.push(...imageComponent.render(width));
			}
		}
		return lines;
	}

	override render(width: number): string[] {
		if (this.hideComponent || this.isSettledWait()) {
			return [];
		}
		switch (this.resolveRenderMode()) {
			case "compact":
				return ["", ...this.renderCompactRow(width)];
			case "self":
				return this.renderSelfShell(width);
			case "default":
				return super.render(width);
		}
	}

	/** A finished wait_agent row carries no information; the agent report follows it. Errors and expanded view keep it. */
	private isSettledWait(): boolean {
		return this.toolName === "wait_agent" && !this.isPartial && !this.result?.isError && !this.expanded;
	}

	private resolveRenderMode(): "compact" | "self" | "default" {
		if (
			this.toolName === "wait_agent" ||
			this.toolName === "end_turn" ||
			(this.hideOutput && this.toolName === "bash")
		) {
			return "compact";
		}
		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			return "self";
		}
		return "default";
	}

	private shouldHideCallDetails(): boolean {
		return this.hideOutput && this.toolName === "pyrun_eval";
	}

	private renderCompactRow(width: number): string[] {
		const paddingX = 1;
		const contentWidth = Math.max(0, width - paddingX * 2);
		const margin = " ".repeat(Math.min(paddingX, Math.max(0, width)));
		const timing = [this.formatTimerText(), this.formatCompletionTime()].filter(
			(text): text is string => text !== undefined,
		);
		const title = theme.fg("toolTitle", theme.bold(this.toolTitle));
		const row = [title, ...timing.map((text) => theme.fg("muted", text))].join(" ");
		const line = margin + truncateToWidth(row, contentWidth, "");
		const lines = [line];

		const resultComponent = this.hideOutput ? undefined : this.resultRendererComponent;
		const showResult = this.result?.isError || this.expanded;
		if (showResult && resultComponent) {
			const resultLines = [...resultComponent.render(contentWidth)];
			while (resultLines[0]?.trim() === "") resultLines.shift();
			while (resultLines.at(-1)?.trim() === "") resultLines.pop();
			lines.push(...resultLines.map((line) => margin + truncateToWidth(line, contentWidth, "")));
		}
		return lines;
	}

	private applyBackground(text: string): string {
		const color = this.isPartial ? "toolPendingBg" : this.result?.isError ? "toolErrorBg" : "toolSuccessBg";
		return theme.bg(color, text);
	}

	private updateDisplay(): void {
		const bgFn = (text: string) => this.applyBackground(text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			renderContainer.clear();

			const callRenderer = this.shouldHideCallDetails() ? undefined : this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createCallFallback());
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(component);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createCallFallback());
					hasContent = true;
				}
			}

			if (this.getRenderShell() !== "self") {
				const timerComponent = this.createTimerComponent();
				if (timerComponent) {
					renderContainer.addChild(timerComponent);
					hasContent = true;
				}
			}

			if (this.result) {
				// Result renderers own renderer state such as live timers, so they run even when output is hidden.
				const component = this.renderResultComponent();
				if (component && !this.hideOutput) {
					renderContainer.addChild(component);
					hasContent = true;
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			this.resultRendererComponent = this.createResultFallback();
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result && !this.hideOutput) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (const [i, img] of imageBlocks.entries()) {
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const cached = this.convertedImages.get(i);
					const converted =
						cached?.sourceData === img.data && cached.sourceMimeType === img.mimeType ? cached : undefined;
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private renderResultComponent(): Component | undefined {
		const resultRenderer = this.getResultRenderer();
		if (!resultRenderer || !this.result) {
			this.resultRendererComponent = this.createResultFallback();
			return this.resultRendererComponent;
		}
		try {
			const component = resultRenderer(
				{
					content: this.getDisplayContent() as AgentToolResult<unknown>["content"],
					details: this.result.details,
				},
				{ expanded: this.expanded, isPartial: this.isPartial },
				theme,
				this.getRenderContext(this.resultRendererLastComponent),
			);
			this.resultRendererComponent = component;
			this.resultRendererLastComponent = component;
			return component;
		} catch {
			this.resultRendererLastComponent = undefined;
			this.resultRendererComponent = this.createResultFallback();
			return this.resultRendererComponent;
		}
	}

	private getDisplayContent(): ToolResultContentItem[] {
		return limitToolResultContent(this.result?.content ?? []);
	}

	private getTextOutput(content: ToolResultContentItem[] = this.result?.content ?? []): string {
		return getRenderedTextOutput({ content }, this.showImages);
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolTitle));
		const content = this.shouldHideCallDetails() ? undefined : JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const timingText = [this.formatTimerText(), this.formatCompletionTime()].filter(Boolean).join(" ");
		if (timingText) {
			text += `\n${theme.fg("muted", timingText)}`;
		}
		const output = this.hideOutput ? "" : this.getTextOutput(this.getDisplayContent());
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
