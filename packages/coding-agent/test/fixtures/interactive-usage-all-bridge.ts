import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

type UsageWindow = { percent: number; resetsAt: string };
type ClaudeAccountUsage =
	| { account: string; selected: boolean; fiveHour: UsageWindow | null; weekly: UsageWindow | null }
	| { account: string; selected: boolean; error: string };

export default function registerUsageAllBridge(pi: ExtensionAPI): void {
	pi.events.on("claude-bridge:usage-all-request", (data: unknown) => {
		const request = data as { accounts?: Promise<ClaudeAccountUsage[]> };
		// Assignment must happen during emit, not after an await.
		request.accounts = Promise.resolve([
			{
				account: "claude-selected@example.test",
				selected: true,
				fiveHour: { percent: 37, resetsAt: "2030-01-02T03:04:00Z" },
				weekly: { percent: 59, resetsAt: "2030-01-08T05:06:00Z" },
			},
			{ account: "claude-error@example.test", selected: false, error: "Fixture Claude account unavailable" },
		]);
	});
}
