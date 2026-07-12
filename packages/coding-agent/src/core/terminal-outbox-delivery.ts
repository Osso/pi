import type { MultiAgentStore } from "./multi-agent-store.ts";
import {
	claimMultiAgentTerminalOutbox,
	cleanupMultiAgentTerminalOutbox,
	deliverMultiAgentTerminalOutbox,
	failMultiAgentTerminalOutbox,
	type MultiAgentTerminalOutboxRecord,
	readMultiAgentAgent,
} from "./session-control-db.ts";

const TERMINAL_OUTBOX_CLAIM_LEASE_MS = 30_000;
const TERMINAL_OUTBOX_MAX_ATTEMPTS = 5;
const TERMINAL_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface DeliverTerminalOutboxOptions {
	claimId: string;
	controlDbPath: string;
	now: () => string;
	store: MultiAgentStore;
}

export function deliverTerminalOutboxProjections(options: DeliverTerminalOutboxOptions): number {
	const persistence = options.store.getPersistenceTarget();
	if (!persistence) return 0;

	let delivered = 0;
	const cleanupNow = options.now();
	cleanupMultiAgentTerminalOutbox(
		options.controlDbPath,
		new Date(Date.parse(cleanupNow) - TERMINAL_OUTBOX_RETENTION_MS).toISOString(),
	);
	while (true) {
		const nowIso = options.now();
		const record = claimMultiAgentTerminalOutbox(options.controlDbPath, options.claimId, nowIso, {
			maxAttempts: TERMINAL_OUTBOX_MAX_ATTEMPTS,
			sessionPath: persistence.sessionPath,
			staleClaimBefore: new Date(Date.parse(nowIso) - TERMINAL_OUTBOX_CLAIM_LEASE_MS).toISOString(),
		});
		if (!record) return delivered;

		deliverTerminalOutboxProjection(options, record);
		delivered += 1;
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
