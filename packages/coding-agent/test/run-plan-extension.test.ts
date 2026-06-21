import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import runPlanExtension, { findNextPlanItem } from "../src/extensions/run-plan.ts";

type RegisteredRunPlanCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;

function createRunPlanHarness(cwd: string) {
	let command: RegisteredRunPlanCommand | undefined;
	const appendEntry = vi.fn();
	const notify = vi.fn();
	const sendUserMessage = vi.fn();

	const pi = {
		appendEntry,
		registerCommand(name: string, options: RegisteredRunPlanCommand) {
			if (name === "run-plan") {
				command = options;
			}
		},
		sendUserMessage,
	} as unknown as ExtensionAPI;

	runPlanExtension(pi);

	const ctx = { cwd, ui: { notify } } as unknown as ExtensionCommandContext;

	return {
		complete: async (prefix: string) => command?.getArgumentCompletions?.(prefix),
		runCommand: async (args: string) => command?.handler(args, ctx),
		appendEntry,
		notify,
		sendUserMessage,
	};
}

describe("run-plan extension", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = join(tmpdir(), `pi-run-plan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("finds the first unchecked plan item and skips checked items", async () => {
		const planPath = join(cwd, "PLAN.md");
		writeFileSync(
			planPath,
			["- [x] Done item", "* [X] Also done", "- [ ] First open item", "* [ ] Second open item"].join("\n"),
		);

		await expect(findNextPlanItem(planPath)).resolves.toBe("First open item");
	});

	it("returns null when all plan items are checked", async () => {
		const planPath = join(cwd, "PLAN.md");
		writeFileSync(planPath, "- [x] Done item\n* [X] Also done\n");

		await expect(findNextPlanItem(planPath)).resolves.toBeNull();
	});

	it("submits the next item and records the active plan file", async () => {
		writeFileSync(join(cwd, "PLAN.md"), "- [ ] Implement run plan\n");
		const harness = createRunPlanHarness(cwd);

		await harness.runCommand("");

		expect(process.env.PI_PLAN_FILE).toBe("PLAN.md");
		expect(harness.appendEntry).toHaveBeenCalledWith("run-plan:active", { file: "PLAN.md" });
		expect(harness.sendUserMessage).toHaveBeenCalledWith("Implement run plan");
	});

	it("uses an inline plan filename argument", async () => {
		writeFileSync(join(cwd, "ALT.md"), "* [ ] Alternate plan\n");
		const harness = createRunPlanHarness(cwd);

		await harness.runCommand("ALT.md");

		expect(process.env.PI_PLAN_FILE).toBe("ALT.md");
		expect(harness.sendUserMessage).toHaveBeenCalledWith("Alternate plan");
	});

	it("notifies when the plan file is missing or complete", async () => {
		writeFileSync(join(cwd, "PLAN.md"), "- [x] Done\n");
		const harness = createRunPlanHarness(cwd);

		await harness.runCommand("MISSING.md");
		await harness.runCommand("");

		expect(harness.notify).toHaveBeenCalledWith("Plan file not found: MISSING.md", "error");
		expect(harness.notify).toHaveBeenCalledWith("No unchecked items in PLAN.md", "info");
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("completes markdown files in the session cwd", async () => {
		writeFileSync(join(cwd, "PLAN.md"), "- [ ] Default\n");
		writeFileSync(join(cwd, "ALT.md"), "- [ ] Alternate\n");
		writeFileSync(join(cwd, "notes.txt"), "- [ ] Ignored\n");
		const harness = createRunPlanHarness(cwd);
		const originalCwd = process.cwd();
		process.chdir(cwd);

		try {
			const completions = await harness.complete("");

			expect(completions?.map((completion) => completion.value).sort()).toEqual(["ALT.md", "PLAN.md"]);
		} finally {
			process.chdir(originalCwd);
		}
	});
});
