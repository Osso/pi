import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const MS_PER_SECOND = 1000;

/**
 * Output speed of the latest finished reply: its output tokens over the provider request's wall time, from
 * `model_request_start` to the reply's end, time to first token included. Hidden reasoning tokens count as output
 * but are generated before the first streamed update, so timing from that update overstates the speed. Pi stores
 * no reply durations, so nothing is known after a restart.
 */
export class ReplySpeed {
	private requestStartedAt: number | undefined;
	private tokensPerSecond: number | undefined;

	get(): number | undefined {
		return this.tokensPerSecond;
	}

	recordRequestStart(now: number): void {
		this.requestStartedAt = now;
	}

	/** Returns true when the displayed speed changed. */
	recordEnd(message: AgentMessage, now: number): boolean {
		if (message.role !== "assistant") return false;
		const startedAt = this.requestStartedAt;
		this.requestStartedAt = undefined;
		const speed = startedAt === undefined ? undefined : outputSpeed(message, now - startedAt);
		if (speed === undefined) return false;
		this.tokensPerSecond = speed;
		return true;
	}
}

/** Failed or untimed replies have no meaningful generation time. */
function outputSpeed(message: AssistantMessage, elapsedMs: number): number | undefined {
	const finished = message.stopReason !== "error" && message.stopReason !== "aborted";
	const measurable = finished && elapsedMs > 0 && message.usage.output > 0;
	return measurable ? message.usage.output / (elapsedMs / MS_PER_SECOND) : undefined;
}
