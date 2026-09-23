import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createHarness, getUserTexts } from "./harness.ts";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

it.each(["prompt", "continue"] as const)(
	"does not duplicate post-run continuation after manual compaction from %s",
	async (entry) => {
		const toolStarted = gate();
		const releaseTool = gate();
		const compactionStarted = gate();
		const releaseCompaction = gate();
		const resumedModelStarted = gate();
		const releaseResumedModel = gate();
		const order: string[] = [];
		const waitTool: AgentTool = {
			name: "wait_for_release",
			label: "Wait",
			description: "Wait until released during manual compaction",
			parameters: Type.Object({}),
			async execute() {
				order.push("tool_started");
				toolStarted.release();
				await releaseTool.promise;
				order.push("tool_released");
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [waitTool],
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => {
						order.push("compaction_extension_started");
						compactionStarted.release();
						await releaseCompaction.promise;
						return {
							compaction: {
								summary: "Earlier task summarized",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		const { session } = harness;
		const errors: string[] = [];
		let starts = 0;
		let queuedSteering: Promise<void> | undefined;
		const record = (label: string) => (event: { type: string }) => {
			if (label === "agent" && event.type === "agent_start" && ++starts === 3) {
				queuedSteering = session.followUp("Handle steering after compaction");
				order.push("steering_queued_at_resumed_start");
			}
			if (
				[
					"agent_start",
					"agent_end",
					"message_end",
					"compaction_start",
					"compaction_end",
					"steering_message_queued",
				].includes(event.type)
			) {
				order.push(`${label}:${event.type}`);
			}
		};
		session.subscribe(record("session"));
		session.agent.subscribe(record("agent"));
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Earlier task complete" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("wait_for_release", {}), {
					stopReason: "toolUse",
				}),
				async () => {
					order.push("resumed_model_started");
					resumedModelStarted.release();
					await releaseResumedModel.promise;
					return fauxAssistantMessage("Resumed turn complete");
				},
				fauxAssistantMessage("Steering handled"),
			]);
			order.push("earlier_prompt_start");
			await session.prompt("Earlier task");
			order.push("earlier_prompt_end");
			const original = (entry === "prompt" ? session.prompt("Run a tool") : session.continue()).catch(
				(error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					errors.push(`original: ${message}`);
				},
			);
			await Promise.race([
				toolStarted.promise,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error(`tool start timed out: ${order.join(", ")}`)), 1_000),
				),
			]);
			const compacting = session.compact().catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				errors.push(`compact: ${message}`);
			});
			releaseTool.release();
			await Promise.race([
				compactionStarted.promise,
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new Error(`compaction start timed out: ${order.join(", ")}; ${errors.join(", ")}`)),
						1_000,
					),
				),
			]);
			order.push("compaction_waiting");
			releaseCompaction.release();
			await Promise.race([
				resumedModelStarted.promise,
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new Error(`resumed model timed out: ${order.join(", ")}; ${errors.join(", ")}`)),
						1_000,
					),
				),
			]);
			await queuedSteering;
			await Promise.race([
				original,
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new Error(`original prompt did not settle during resumed run: ${order.join(", ")}`)),
						1_000,
					),
				),
			]);
			const resumedRunStillActive = session.isStreaming;
			order.push("original_settled_during_resumed_model");
			releaseResumedModel.release();
			await compacting;
			expect(resumedRunStillActive).toBe(true);
			expect(order).toContain("compaction_waiting");
			expect(order.indexOf("compaction_waiting")).toBeLessThan(order.indexOf("resumed_model_started"));
			expect(errors).toEqual([]);
			expect(getUserTexts(harness).filter((text) => text === "Handle steering after compaction")).toHaveLength(1);
			expect(starts).toBe(4);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			releaseTool.release();
			releaseCompaction.release();
			releaseResumedModel.release();
			harness.cleanup();
		}
	},
	10_000,
);
