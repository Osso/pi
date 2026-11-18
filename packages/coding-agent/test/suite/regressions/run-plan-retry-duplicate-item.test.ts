import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import runPlanExtension from "../../../extensions/run-plan/src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function userTexts(harness: Harness): string[] {
	return harness.session.messages.flatMap((message) => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		return [message.content.map((part) => (part.type === "text" ? part.text : "")).join("")];
	});
}

// A failed attempt ends a run before its automatic retry. /run-plan submitted the next unchecked
// item on that first agent_end, so the item still being retried was queued and worked a second time.
describe("/run-plan with an automatic retry", () => {
	it("submits the plan item once when the first attempt fails and the retry finishes it", async () => {
		const harness = await createHarness({
			noSupervisor: true,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			extensionFactories: [runPlanExtension],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName([]);
		const planPath = join(harness.tempDir, "PLAN.md");
		writeFileSync(planPath, "# Plan\n\n- [ ] Write the parser\n");
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			() => {
				writeFileSync(planPath, readFileSync(planPath, "utf8").replace("- [ ]", "- [x]"));
				return fauxAssistantMessage("Parser written.");
			},
		]);

		await harness.session.prompt(`/run-plan ${planPath}`);
		// The queued duplicate, if any, runs after the settled run; give it time to be delivered.
		await new Promise((resolve) => setTimeout(resolve, 200));
		await harness.session.agent.waitForIdle();

		const planPrompts = userTexts(harness).filter((text) => text.includes("Write the parser"));
		expect(planPrompts).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
	});
});
