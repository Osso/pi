import { Type } from "typebox";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

export const CONFIRM_TITLE = "Intervening regression confirm";
export const CONFIRM_MESSAGE = "Continue independent work?";

export default function registerQuestionConfirmProbe(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "test_question_confirm",
		label: "Confirm regression work",
		description: "Open an intervening confirm dialog for the queued-question PTY regression",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const confirmed = await ctx.ui.confirm(CONFIRM_TITLE, CONFIRM_MESSAGE);
			return { content: [{ type: "text", text: `confirmed=${confirmed}` }], details: { confirmed } };
		},
	});
}
