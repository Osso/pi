import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

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

export default function specValidationExtension(pi: ExtensionAPI) {
	pi.registerCommand("spec-validation", {
		description: "Validate each docs/specs/*.md file separately",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				throw new Error("/spec-validation is blocked while a task is running");
			}

			pi.sendUserMessage(SPEC_VALIDATION_PROMPT);
			ctx.ui.setEditorText("");
		},
	});
}
