import { readClaudeSubscriptionCapacity, type UsageRuntime } from "./claude-usage.ts";
import { ACCOUNTS_EXHAUSTED, type AccountProfileManager } from "./query-state.ts";

function assertRecheckNotCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Claude account quota recheck cancelled");
}

function recordRecheckFailure(name: string, error: unknown, failures: string[]): void {
	const reason = error instanceof Error ? error.message : "Cannot read subscription usage";
	failures.push(`${name}: ${reason}`);
}

/** Only the exhausted startup path probes usage; a healthy selection never hits this endpoint. */
export async function recheckAccountProfiles(
	manager: AccountProfileManager,
	names: readonly string[],
	home: string,
	modelId: string,
	signal?: AbortSignal,
	usageRuntime: Partial<UsageRuntime> = {},
): Promise<void> {
	const failures: string[] = [];
	for (const name of names) {
		assertRecheckNotCancelled(signal);
		const checkedAt = Date.now() / 1000;
		let available: boolean;
		try {
			available = await readClaudeSubscriptionCapacity({ home, name, profile: name }, modelId, usageRuntime);
		} catch (error) {
			assertRecheckNotCancelled(signal);
			recordRecheckFailure(name, error, failures);
			continue;
		}
		assertRecheckNotCancelled(signal);
		if (available && manager.recover(name, checkedAt)) return;
	}
	const detail = failures.length ? ` Live quota recheck failed — ${failures.join("; ")}` : "";
	throw new Error(`${ACCOUNTS_EXHAUSTED}${detail}`);
}
