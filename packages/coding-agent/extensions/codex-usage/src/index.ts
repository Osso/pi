import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { dispatchClaudeUsageRequest, handleUsageAccounts, handleUsageDeepseek, isUsageScope } from "./account-usage.ts";
import { handleUsageRead, handleUsageReset } from "./codex-usage.ts";

export type {
	CodexAccountInfo,
	CodexAdditionalRateLimitPayload,
	CodexCredits,
	CodexCreditsPayload,
	CodexRateLimit,
	CodexRateLimitDetailsPayload,
	CodexRateLimitWindow,
	CodexRateLimitWindowPayload,
	CodexUsage,
	CodexUsagePayload,
} from "./codex-usage.ts";
export {
	formatCodexUsage,
	mapCodexUsagePayload,
	resolveCodexAccountId,
	resolveCodexAccountInfo,
	resolveCodexDisplayEmail,
} from "./codex-usage.ts";
export type { DeepseekRow, DeepseekWindow } from "./deepseek-usage.ts";
export {
	formatDeepseekUsage,
	mapCommandCodeUsage,
	mapDeepseekBalance,
	mapOpencodeGoUsage,
	mapOpenGroveUsage,
	mapOpenRouterUsage,
} from "./deepseek-usage.ts";

const USAGE_ARGUMENTS = ["all", "claude", "openai", "deepseek", "reset"];

export default function codexUsageExtension(pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Show Codex, Claude, or DeepSeek usage; scope with all, claude, or openai",
		getArgumentCompletions: (prefix) => {
			const matches = USAGE_ARGUMENTS.filter((option) => option.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const commandArgs = args.trim();
			if (isUsageScope(commandArgs)) {
				await handleUsageAccounts(ctx, pi, commandArgs);
				return;
			}
			if (commandArgs === "deepseek") {
				await handleUsageDeepseek(ctx, pi);
				return;
			}
			if (ctx.model?.provider === "claude-bridge") {
				await dispatchClaudeUsageRequest(args, ctx, pi);
				return;
			}
			if (commandArgs === "reset") {
				await handleUsageReset(ctx, pi);
				return;
			}
			if (commandArgs.length > 0) {
				ctx.ui.notify(`Usage: /usage [${USAGE_ARGUMENTS.join("|")}]`, "warning");
				return;
			}
			await handleUsageRead(ctx, pi);
		},
	});
}
