import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const MS_PER_SECOND = 1000;

/**
 * Output speed of the latest finished reply, timed from its first streamed update to its end, so request
 * queueing and time to first token do not count. Pi stores no reply durations, so nothing is known after a restart.
 */
export class ReplySpeed {
	private firstUpdateAt: number | undefined;
	private tokensPerSecond: number | undefined;

	get(): number | undefined {
		return this.tokensPerSecond;
	}

	recordUpdate(message: AgentMessage, now: number): void {
		if (message.role !== "assistant") return;
		this.firstUpdateAt ??= now;
	}

	/** Returns true when the displayed speed changed. */
	recordEnd(message: AgentMessage, now: number): boolean {
		if (message.role !== "assistant") return false;
		const startedAt = this.firstUpdateAt;
		this.firstUpdateAt = undefined;
		const speed = startedAt === undefined ? undefined : outputSpeed(message, now - startedAt);
		if (speed === undefined) return false;
		this.tokensPerSecond = speed;
		return true;
	}
}

/** Failed or unstreamed replies have no meaningful generation time. */
function outputSpeed(message: AssistantMessage, elapsedMs: number): number | undefined {
	const finished = message.stopReason !== "error" && message.stopReason !== "aborted";
	const measurable = finished && elapsedMs > 0 && message.usage.output > 0;
	return measurable ? message.usage.output / (elapsedMs / MS_PER_SECOND) : undefined;
}
