import { describe, expect, it, vi } from "vitest";
import specValidationExtension from "../extensions/spec-validation/src/index.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";

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

type SpecValidationCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;

function createHarness(idle: boolean) {
	let command: SpecValidationCommand | undefined;
	const sendUserMessage = vi.fn();
	const setEditorText = vi.fn();
	const isIdle = vi.fn(() => idle);

	const pi = {
		registerCommand(name: string, options: SpecValidationCommand) {
			if (name === "spec-validation") command = options;
		},
		sendUserMessage,
	} as unknown as ExtensionAPI;

	specValidationExtension(pi);

	const ctx = {
		isIdle,
		ui: { setEditorText },
	} as unknown as ExtensionCommandContext;

	return {
		command,
		runCommand: async () => command?.handler("", ctx),
		sendUserMessage,
		setEditorText,
	};
}

describe("spec validation extension", () => {
	it("starts one native agent turn with the Codex validation workflow", async () => {
		const harness = createHarness(true);

		expect(harness.command?.description).toBe("Validate each docs/specs/*.md file separately");

		await harness.runCommand();

		expect(harness.sendUserMessage).toHaveBeenCalledOnce();
		expect(harness.sendUserMessage).toHaveBeenCalledWith(SPEC_VALIDATION_PROMPT);
		expect(harness.setEditorText).toHaveBeenCalledWith("");
	});

	it("rejects the command while an agent turn is running", async () => {
		const harness = createHarness(false);

		await expect(harness.runCommand()).rejects.toThrow(
			"/spec-validation is blocked while a task is running",
		);
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.setEditorText).not.toHaveBeenCalled();
	});
});
