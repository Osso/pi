import type { ExtensionAPI, ExtensionCommandContext } from "../../../src/core/extensions/types.ts";
import { getControlDbPath } from "../../../src/core/session-control-db.ts";
import {
	type AskTarget,
	askAgent,
	listAskTargets,
	openQuestionCenter,
	type QuestionCenter,
} from "../../../src/questions/question-center.ts";

const USAGE = "Usage: /ask [<session-id-prefix> <question>]";

function findTarget(targets: AskTarget[], prefix: string): AskTarget {
	const matches = targets.filter((target) => target.sessionId.startsWith(prefix));
	if (matches.length === 1 && matches[0]) return matches[0];
	throw new Error(
		matches.length === 0
			? `No session ID starts with ${prefix}.`
			: `${prefix} matches ${matches.length} sessions; type more of the session ID.`,
	);
}

async function pickTarget(targets: AskTarget[], ctx: ExtensionCommandContext): Promise<AskTarget | undefined> {
	if (targets.length === 0) throw new Error("No session can receive a question.");
	const label = await ctx.ui.select(
		"Ask which session?",
		targets.map((target) => target.label),
	);
	return targets.find((target) => target.label === label);
}

/** `/ask <prefix> <question>` asks directly; bare `/ask` picks the session and then the question. */
async function readAsk(
	center: QuestionCenter,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<{ target: AskTarget; question: string } | undefined> {
	const ownSessionId = ctx.sessionManager.getSessionId();
	const targets = listAskTargets(center).filter((target) => target.sessionId !== ownSessionId);
	const trimmed = args.trim();
	if (trimmed) {
		const match = /^(\S+)\s+(\S[\s\S]*)$/.exec(trimmed);
		if (!match?.[1] || !match[2]) throw new Error(USAGE);
		return { target: findTarget(targets, match[1]), question: match[2] };
	}
	const target = await pickTarget(targets, ctx);
	if (!target) return undefined;
	const question = await ctx.ui.input(`Ask ${target.label}`);
	return question?.trim() ? { target, question } : undefined;
}

async function runAsk(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.settingsManager) throw new Error("Settings are unavailable; /ask cannot find the question store.");
	const center = openQuestionCenter(ctx.settingsManager, getControlDbPath());
	const ask = await readAsk(center, args, ctx);
	if (!ask) return;
	const entry = askAgent(center, { sessionId: ask.target.sessionId, host: ask.target.host }, ask.question);
	ctx.ui.notify(`Asked ${entry.ref}. The answer shows in pi questions.`, "info");
}

/** Registers `/ask`: the user asks another session a question through the stored user-question path. */
export function registerAskCommand(pi: ExtensionAPI): void {
	pi.registerCommand("ask", {
		description: "Ask another session a question; the answer shows in pi questions",
		handler: async (args, ctx) => {
			try {
				await runAsk(args, ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
