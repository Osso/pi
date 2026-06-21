import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "../core/extensions/types.ts";

const uncheckedItemPattern = /^\s*[-*]\s+\[\s\]\s+(.*)$/;

export async function findNextPlanItem(filePath: string): Promise<string | null> {
	const content = await readFile(filePath, "utf-8");
	for (const line of content.split(/\r?\n/)) {
		const match = uncheckedItemPattern.exec(line);
		if (match) {
			return match[1].trim();
		}
	}
	return null;
}

function resolvePlanFile(cwd: string, args: string): { file: string; path: string } {
	const file = args.trim() || "PLAN.md";
	return { file, path: join(cwd, file) };
}

async function runPlan(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const plan = resolvePlanFile(ctx.cwd, args);
	if (!existsSync(plan.path)) {
		ctx.ui.notify(`Plan file not found: ${plan.file}`, "error");
		return;
	}

	const nextItem = await findNextPlanItem(plan.path);
	if (!nextItem) {
		ctx.ui.notify(`No unchecked items in ${plan.file}`, "info");
		return;
	}

	process.env.PI_PLAN_FILE = basename(plan.file);
	pi.appendEntry("run-plan:active", { file: basename(plan.file) });
	pi.sendUserMessage(nextItem);
}

function completeMarkdownFiles(cwd: string, argumentPrefix: string): Array<{ label: string; value: string }> {
	const normalizedPrefix = argumentPrefix.trim();
	return readdirSync(cwd)
		.filter((entry) => entry.endsWith(".md"))
		.filter((entry) => entry.startsWith(normalizedPrefix))
		.sort((a, b) => a.localeCompare(b))
		.map((entry) => ({ label: entry, value: entry }));
}

export default function runPlanExtension(pi: ExtensionAPI) {
	pi.registerCommand("run-plan", {
		description: "Submit the first unchecked item from PLAN.md or another markdown plan file.",
		getArgumentCompletions: (argumentPrefix: string) => {
			const cwd = process.cwd();
			return completeMarkdownFiles(cwd, argumentPrefix);
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => runPlan(args, ctx, pi),
	});
}
