import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const uncheckedItemPattern = /^\s*[-*]\s+\[\s\]\s+(.*)$/;

export async function findNextPlanItem(
	filePath: string,
): Promise<string | null> {
	const content = await readFile(filePath, "utf-8");
	for (const line of content.split(/\r?\n/)) {
		const match = uncheckedItemPattern.exec(line);
		if (match) {
			return match[1].trim();
		}
	}
	return null;
}

interface ActivePlan {
	file: string;
	cwd: string;
}

function resolvePlanFile(
	cwd: string,
	args: string,
): ActivePlan & { path: string } {
	const file = args.trim() || "PLAN.md";
	return { file, cwd, path: join(cwd, file) };
}

function planPath(plan: ActivePlan): string {
	return join(plan.cwd, plan.file);
}

async function submitNextPlanItem(
	plan: ActivePlan,
	ctx: Pick<ExtensionContext, "ui">,
	pi: ExtensionAPI,
	options?: { followUp?: boolean },
): Promise<boolean> {
	const path = planPath(plan);
	if (!existsSync(path)) {
		ctx.ui.notify(`Plan file not found: ${plan.file}`, "error");
		return false;
	}

	const nextItem = await findNextPlanItem(path);
	if (!nextItem) {
		ctx.ui.notify(`No unchecked items in ${plan.file}`, "info");
		return false;
	}

	if (options?.followUp) {
		pi.sendUserMessage(nextItem, { deliverAs: "followUp" });
	} else {
		pi.sendUserMessage(nextItem);
	}
	return true;
}

async function runPlan(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<ActivePlan | undefined> {
	const plan = resolvePlanFile(ctx.cwd, args);
	if (!(await submitNextPlanItem(plan, ctx, pi))) {
		return undefined;
	}

	process.env.PI_PLAN_FILE = basename(plan.file);
	pi.appendEntry("run-plan:active", { file: basename(plan.file) });
	ctx.ui.setEditorText("");
	return plan;
}

function completeMarkdownFiles(
	cwd: string,
	argumentPrefix: string,
): Array<{ label: string; value: string }> {
	const normalizedPrefix = argumentPrefix.trim();
	return readdirSync(cwd)
		.filter((entry) => entry.endsWith(".md"))
		.filter((entry) => entry.startsWith(normalizedPrefix))
		.sort((a, b) => a.localeCompare(b))
		.map((entry) => ({ label: entry, value: entry }));
}

export default function runPlanExtension(pi: ExtensionAPI) {
	let activePlan: ActivePlan | undefined;

	pi.on("agent_end", async (_event, ctx) => {
		if (!activePlan) {
			return;
		}

		if (!(await submitNextPlanItem(activePlan, ctx, pi, { followUp: true }))) {
			activePlan = undefined;
		}
	});

	pi.registerCommand("run-plan", {
		description:
			"Submit the first unchecked item from PLAN.md or another markdown plan file.",
		getArgumentCompletions: (argumentPrefix: string) => {
			const cwd = process.cwd();
			return completeMarkdownFiles(cwd, argumentPrefix);
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			activePlan = await runPlan(args, ctx, pi);
		},
	});
}
