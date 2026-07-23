import { runDetachedJobArtifactCleanup } from "./detached-job-cleanup.ts";
import type { MultiAgentStore } from "./multi-agent-store.ts";
import {
	claimMultiAgentTerminalOutbox,
	deliverMultiAgentTerminalOutbox,
	failMultiAgentTerminalOutbox,
	type MultiAgentTerminalOutboxRecord,
	readMultiAgentAgent,
} from "./session-control-db.ts";

const TERMINAL_OUTBOX_CLAIM_LEASE_MS = 30_000;
const TERMINAL_OUTBOX_MAX_ATTEMPTS = 5;
export const TERMINAL_OUTBOX_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const TERMINAL_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface DeliverTerminalOutboxOptions {
	artifactRoot?: string;
	claimId: string;
	controlDbPath: string;
	now: () => string;
	store: MultiAgentStore;
}

export function isTerminalOutboxCleanupDue(lastCleanupAt: number | undefined, now: number): boolean {
	return lastCleanupAt === undefined || now - lastCleanupAt >= TERMINAL_OUTBOX_CLEANUP_INTERVAL_MS;
}

export function terminalOutboxRetentionThreshold(now: number): string {
	return new Date(now - TERMINAL_OUTBOX_RETENTION_MS).toISOString();
}

export function deliverTerminalOutboxProjections(options: DeliverTerminalOutboxOptions): number {
	const persistence = options.store.getPersistenceTarget();
	if (!persistence) return 0;

	let delivered = 0;
	try {
		while (true) {
			const nowIso = options.now();
			const record = claimMultiAgentTerminalOutbox(options.controlDbPath, options.claimId, nowIso, {
				maxAttempts: TERMINAL_OUTBOX_MAX_ATTEMPTS,
				sessionPath: persistence.sessionPath,
				staleClaimBefore: new Date(Date.parse(nowIso) - TERMINAL_OUTBOX_CLAIM_LEASE_MS).toISOString(),
			});
			if (!record) break;

			deliverTerminalOutboxProjection(options, record);
			delivered += 1;
		}
		return delivered;
	} finally {
		if (delivered > 0) {
			runDetachedJobArtifactCleanup(options.controlDbPath, options.artifactRoot, Date.parse(options.now()));
		}
	}
}

function deliverTerminalOutboxProjection(
	options: DeliverTerminalOutboxOptions,
	record: MultiAgentTerminalOutboxRecord,
): void {
	try {
		const agent = readMultiAgentAgent(options.controlDbPath, record.sessionPath, record.agentId);
		if (!agent || agent.revision !== record.terminalRevision || !isTerminalLifecycle(agent.lifecycle)) {
			throw new Error(
				`Terminal outbox projection does not match agent ${record.agentId} revision ${record.terminalRevision}`,
			);
		}
		options.store.publishTerminalOutboxSnapshot(agent);
		if (!deliverMultiAgentTerminalOutbox(options.controlDbPath, record, options.now())) {
			throw new Error(`Could not acknowledge terminal outbox projection for ${record.agentId}`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		failMultiAgentTerminalOutbox(options.controlDbPath, record, message, options.now(), {
			maxAttempts: TERMINAL_OUTBOX_MAX_ATTEMPTS,
		});
		throw error;
	}
}

function isTerminalLifecycle(lifecycle: string): boolean {
	return lifecycle === "completed" || lifecycle === "failed" || lifecycle === "aborted";
}
