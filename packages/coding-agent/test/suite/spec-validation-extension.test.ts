import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";

const SPEC_VALIDATION_PROMPT = `Use the \`spec-format\` skill to validate every project spec separately.

Steps:

1. Find all Markdown specs under \`docs/specs/\` in the current project.
2. If \`docs/specs/\` does not exist or contains no Markdown files, report that clearly and stop.
3. For each spec file, validate it independently against the \`spec-format\` requirements:
   - Opening paragraph explains what the feature is and where source lives.
   - Sections appear in the expected order.
   - \`What it must do\` contains testable checkbox bullets.
   - Checked bullets have matching tests listed in \`Tests asserting this spec\`.
   - \`How it works\` links to wiki or architecture docs instead of duplicating implementation prose.
   - \`Implementation inventory\` lists source files with one-line roles.
   - \`Known gaps (current cycle)\` and \`Out of scope\` are explicit.
   - Guessed or inferred requirements are marked or omitted.
4. Produce one result block per spec with \`PASS\` or \`FAIL\`, file path, and concrete issues.
5. Do not edit files unless explicitly asked after the validation report.
`;

describe("spec validation extension integration", () => {
	it("dispatches the first-party command through one native tool-continuation turn", async () => {
		await withHeadlessPi(async (pi) => {
			const specsDirectory = join(pi.paths.workspaceDir, "docs", "specs");
			const specPath = join(specsDirectory, "example.md");
			mkdirSync(specsDirectory, { recursive: true });
			writeFileSync(specPath, "# Example\n");

			const response = await pi.send({ type: "prompt", message: "/spec-validation" });
			expect(response).toMatchObject({ command: "prompt", success: true });

			const initialRequest = await pi.waitForLlmRequest();
			expect(initialRequest.userMessages).toEqual([SPEC_VALIDATION_PROMPT]);
			pi.respondToLlmRequest(
				initialRequest.id,
				fauxAssistantMessage(fauxToolCall("read", { path: specPath }), { stopReason: "toolUse" }),
			);

			const continuationRequest = await pi.waitForLlmRequest((request) =>
				request.messages.some((message) => message.role === "toolResult"),
			);
			expect(continuationRequest.userMessages).toEqual([SPEC_VALIDATION_PROMPT]);
			pi.respondToLlmRequest(continuationRequest.id, fauxAssistantMessage("PASS: docs/specs/example.md"));

			await pi.waitForEvent((event) => event.type === "agent_end");
		});
	});

});
