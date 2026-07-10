import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "../../../src/core/extensions/types.ts";

function getEffortLevels(ctx: ExtensionCommandContext): ThinkingLevel[] | undefined {
	return ctx.model ? (getSupportedThinkingLevels(ctx.model) as ThinkingLevel[]) : undefined;
}

function formatEffortLevels(levels: readonly ThinkingLevel[]): string {
	return levels.join(", ");
}

function findSelectedEffort(levels: readonly ThinkingLevel[], effort: string): ThinkingLevel | undefined {
	return levels.find((level) => level === effort.toLowerCase());
}

function clearEditor(ctx: ExtensionCommandContext): void {
	ctx.ui.setEditorText("");
}

function setEffort(ctx: ExtensionCommandContext, pi: ExtensionAPI, effort: ThinkingLevel): void {
	pi.setThinkingLevel(effort);
	ctx.ui.notify(`Effort: ${pi.getThinkingLevel()}`, "info");
	clearEditor(ctx);
}

function showInvalidEffort(ctx: ExtensionCommandContext, requestedEffort: string, levels: readonly ThinkingLevel[]): void {
	ctx.ui.notify(`Invalid effort "${requestedEffort}". Available: ${formatEffortLevels(levels)}`, "warning");
}

export default function effortExtension(pi: ExtensionAPI) {
	pi.registerCommand("effort", {
		description: "Set model effort level (depends on selected model)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const levels = getEffortLevels(ctx);
			if (!levels) {
				ctx.ui.notify("No model selected", "warning");
				clearEditor(ctx);
				return;
			}

			const requestedEffort = args.trim();
			if (!requestedEffort) {
				const selectedEffort = await ctx.ui.select("Select effort", [...levels]);
				if (!selectedEffort) {
					clearEditor(ctx);
					return;
				}

				const supportedEffort = findSelectedEffort(levels, selectedEffort);
				if (!supportedEffort) {
					clearEditor(ctx);
					return;
				}

				setEffort(ctx, pi, supportedEffort);
				return;
			}

			const selectedEffort = findSelectedEffort(levels, requestedEffort);
			if (!selectedEffort) {
				showInvalidEffort(ctx, requestedEffort, levels);
				clearEditor(ctx);
				return;
			}

			setEffort(ctx, pi, selectedEffort);
		},
	});
}
