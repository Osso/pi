import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const uncheckedItemPattern = /^\s*[-*]\s+\[\s\]\s+(.*)$/;
const activePlanEntryType = "run-plan:active";

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

const RUN_PLAN_AGENT_INSTRUCTION =
	"[run-plan: Do not read PLAN.md. Work on this selected item, then check off that exact item in PLAN.md when it is resolved.]";

interface ActivePlan {
	file: string;
	path: string;
}

function readPersistedActivePlan(ctx: Pick<ExtensionContext, "sessionManager">): ActivePlan | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== activePlanEntryType) continue;
		if (!entry.data || typeof entry.data !== "object") return undefined;
		const record = entry.data as Record<string, unknown>;
		if (typeof record.file !== "string" || typeof record.path !== "string") return undefined;
		return { file: record.file, path: record.path };
	}
	return undefined;
}

function persistActivePlan(pi: ExtensionAPI, plan: ActivePlan | undefined): void {
	pi.appendEntry(activePlanEntryType, plan ? { file: basename(plan.file), path: plan.path } : null);
}

function resolvePlanFile(cwd: string, args: string): ActivePlan {
	const file = args.trim() || "PLAN.md";
	return { file, path: join(cwd, file) };
}

function buildPlanPrompt(item: string): string {
	return `${item}\n\n${RUN_PLAN_AGENT_INSTRUCTION}`;
}

function planFileEnvValue(plan: ActivePlan): string {
	return basename(plan.file) === "PLAN.md" ? "1" : basename(plan.file);
}

function clearPlanEnvironment(): void {
	delete process.env.PLAN_FILE;
	delete process.env.PLAN_PATH;
	delete process.env.PI_PLAN_FILE;
	delete process.env.PI_PLAN_PATH;
}

function exportPlanEnvironment(plan: ActivePlan): void {
	process.env.PLAN_FILE = planFileEnvValue(plan);
	process.env.PLAN_PATH = plan.path;
	process.env.PI_PLAN_FILE = basename(plan.file);
	process.env.PI_PLAN_PATH = plan.path;
}

async function submitNextPlanItem(
	plan: ActivePlan,
	ctx: Pick<ExtensionContext, "ui">,
	pi: ExtensionAPI,
	options?: { followUp?: boolean },
): Promise<boolean> {
	if (!existsSync(plan.path)) {
		throw new Error(`Plan file not found: ${plan.file}`);
	}

	const nextItem = await findNextPlanItem(plan.path);
	if (!nextItem) {
		ctx.ui.notify(`No unchecked items in ${plan.file}`, "info");
		return false;
	}

	const prompt = buildPlanPrompt(nextItem);
	if (options?.followUp) {
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	} else {
		pi.sendUserMessage(prompt);
	}
	return true;
}

async function runPlan(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<ActivePlan | undefined> {
	if (!ctx.isIdle()) {
		throw new Error("/run-plan is blocked while a task is running");
	}

	const plan = resolvePlanFile(ctx.cwd, args);
	if (!(await submitNextPlanItem(plan, ctx, pi))) {
		return undefined;
	}

	exportPlanEnvironment(plan);
	persistActivePlan(pi, plan);
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

	pi.on("session_start", async (_event, ctx) => {
		clearPlanEnvironment();
		activePlan = readPersistedActivePlan(ctx);
		if (activePlan) exportPlanEnvironment(activePlan);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (event.sessionContinuation) return;
		if (!activePlan) {
			return;
		}

		if (!(await submitNextPlanItem(activePlan, ctx, pi, { followUp: true }))) {
			activePlan = undefined;
			persistActivePlan(pi, undefined);
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
