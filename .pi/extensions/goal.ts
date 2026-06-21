/**
 * Goal System (`/goal`)
 *
 * Sets or views the objective for a long-running task (modeled on codex's
 * `/goal`). A goal is a persistent objective string — NOT a checklist of gates.
 * Once set, the agent starts working toward it, and the objective is injected
 * into the system prompt every turn so it stays anchored across the run and
 * across resume.
 *
 * State is persisted to an inspectable, hand-editable `.pi/goal.json`.
 *
 * Commands:
 *   /goal <objective>   set the objective and start working toward it
 *   /goal               view the active objective
 *   /goal clear         clear the active objective
 *
 * See docs/specs/goal-system.md for the contract.
 *
 * NOT YET IMPLEMENTED (codex has these; see spec "Known gaps"):
 *   - autonomous continue-when-idle until the objective is achieved
 *   - token / wall-clock budget bounds on the long-running task
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** codex caps the objective at 4000 characters. */
const MAX_OBJECTIVE_CHARS = 4000;

interface Goal {
	objective: string;
	branch: string;
	createdAt: string;
}

function goalPath(cwd: string): string {
	return path.join(cwd, ".pi", "goal.json");
}

function loadGoal(cwd: string): Goal | null {
	const file = goalPath(cwd);
	if (!fs.existsSync(file)) return null;
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as Goal;
	} catch {
		return null;
	}
}

function saveGoal(cwd: string, goal: Goal): void {
	const file = goalPath(cwd);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(goal, null, 2)}\n`, "utf8");
}

function clearGoal(cwd: string): boolean {
	const file = goalPath(cwd);
	if (!fs.existsSync(file)) return false;
	fs.rmSync(file);
	return true;
}

function currentBranch(cwd: string): string {
	try {
		return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "(no branch)";
	}
}

/** The block injected into the system prompt each turn while a goal is active. */
function goalSystemBlock(goal: Goal): string {
	return [
		"<goal>",
		`Long-running objective: ${goal.objective}`,
		`(set on ${goal.branch} at ${goal.createdAt})`,
		"",
		"Keep working toward this objective across turns until it is achieved.",
		"When it is achieved, state clearly that the goal is complete. If you cannot",
		"make further progress, say what is blocking it rather than stopping silently.",
		"</goal>",
	].join("\n");
}

export default function goalExtension(pi: ExtensionAPI) {
	// Notify on session start if an objective is active.
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		const goal = loadGoal(ctx.cwd);
		if (goal) ctx.ui.notify(`Active goal: ${goal.objective}`, "info");
	});

	// Inject the active objective into the system prompt every turn.
	pi.on("before_agent_start", async (event, ctx) => {
		const goal = loadGoal(ctx.cwd);
		if (!goal) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${goalSystemBlock(goal)}` };
	});

	pi.registerCommand("goal", {
		description: "Set or view the objective for a long-running task (/goal <objective> | /goal | /goal clear)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const objective = args.trim();
			const cwd = ctx.cwd;

			// View
			if (!objective) {
				const goal = loadGoal(cwd);
				ctx.ui.notify(goal ? `Goal: ${goal.objective}` : "No active goal — use /goal <objective>", "info");
				return;
			}

			// Clear
			if (objective === "clear") {
				ctx.ui.notify(clearGoal(cwd) ? "Goal cleared" : "No active goal", "info");
				return;
			}

			// Set
			if (objective.length > MAX_OBJECTIVE_CHARS) {
				ctx.ui.notify(`Objective too long (${objective.length} > ${MAX_OBJECTIVE_CHARS} chars)`, "error");
				return;
			}
			const goal: Goal = { objective, branch: currentBranch(cwd), createdAt: new Date().toISOString() };
			saveGoal(cwd, goal);
			ctx.ui.notify("Goal set — starting work", "info");

			// Setting a goal immediately starts the agent working toward it.
			// The objective is also injected via before_agent_start every turn.
			if (ctx.isIdle()) {
				pi.sendUserMessage(`Work toward this objective until it is achieved: ${objective}`);
			} else {
				ctx.ui.notify("Agent is busy — goal saved; it will guide the current run.", "warning");
			}
		},
	});
}
