import type { MultiAgentStore } from "./multi-agent-store.ts";
import {
	claimMultiAgentTerminalOutbox,
	deliverMultiAgentTerminalOutbox,
	failMultiAgentTerminalOutbox,
	type MultiAgentTerminalOutboxRecord,
	readMultiAgentAgent,
} from "./session-control-db.ts";

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
	while (true) {
		const nowIso = options.now();
		const record = claimMultiAgentTerminalOutbox(options.controlDbPath, options.claimId, nowIso, {
			sessionPath: persistence.sessionPath,
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
		failMultiAgentTerminalOutbox(options.controlDbPath, record, message, options.now());
		throw error;
	}
}

function isTerminalLifecycle(lifecycle: string): boolean {
	return lifecycle === "completed" || lifecycle === "failed" || lifecycle === "aborted";
}
