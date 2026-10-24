import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";

const dtach = process.env.DTACH ?? "detach";
const runtime = process.env.TUI_TEST_RUNTIME ?? process.execPath;
const hasDtach = process.platform !== "win32" && spawnSync(dtach, ["-v"]).error === undefined;
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const question = "Which foreground regression should stay visible?";
const answer = "Keep attached PTY coverage";
const footer = ["FOCUS_TEST_WORKSPACE /isolated/workspace", "FOCUS_TEST_MODEL offline-no-provider"];

type Event = {
	event: string;
	pid: number;
	runtime: "bun" | "node";
	execPath: string;
	columns: number;
	rows: number;
	result?: { answers: Record<string, string>; cancelled: boolean };
};
type Capture = { captures: Record<string, string>; events: Event[]; clients: number[] };

function runDtachScenario(root: string, scenario: string): Capture {
	const result = spawnSync(
		"python3",
		[path.join(fixtures, "dtach-focus.py"), root, dtach, runtime, path.join(fixtures, "dtach-focus.ts"), scenario],
		{ encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
	);
	fs.writeFileSync(path.join(root, "driver.stdout.log"), result.stdout ?? "");
	fs.writeFileSync(path.join(root, "driver.stderr.log"), result.stderr ?? "");
	assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}\n${result.stdout}`);
	return JSON.parse(result.stdout) as Capture;
}

function assertSharedRuntimeAndAnswer({ events, clients }: Capture, scenario: string): void {
	assert.equal(clients.length, 2, "two simultaneously attached real PTY clients are required");
	assert.equal(new Set(events.map((event) => event.pid)).size, 1, "one shared TUI process");
	assert.deepEqual(events.find((event) => event.event === "answered")?.result, {
		answers: { [question]: answer },
		cancelled: false,
	});
	const ready = events.find((event) => event.event === "ready");
	assert.ok(ready, "child runtime reported ready");
	const expectedExecutable = fs.realpathSync(runtime);
	assert.equal(fs.realpathSync(ready.execPath), expectedExecutable, "configured runtime executed fixture");
	assert.equal(ready.runtime, path.basename(expectedExecutable), "child runtime identity matches executable");
	assert.equal(
		events.some((event) => event.event === "received:\x1b[O"),
		scenario === "other-client-blur",
	);
}

function requireCapturedText(captures: Record<string, string>, phase: string): string {
	const text = captures[phase];
	assert.equal(typeof text, "string", `missing ${phase} capture`);
	assert.ok(text !== undefined, `missing ${phase} capture`);
	return text;
}

async function replayCapturedViewports(captures: Capture["captures"]): Promise<Record<string, string>> {
	const terminal = new xterm.Terminal({ cols: 299, rows: 61, scrollback: 1000, allowProposedApi: true });
	const snapshots: Record<string, string> = {};
	try {
		for (const phase of [
			"initial",
			"secondAttach",
			"foregroundFocus",
			"beforeMount",
			"mounted",
			"shrink",
			"sameSizeWinch",
			"recovered",
		]) {
			if (phase === "shrink") terminal.resize(156, 46);
			const capture = requireCapturedText(captures, phase);
			await new Promise<void>((resolve) => terminal.write(capture, resolve));
			snapshots[phase] = Array.from(
				{ length: terminal.rows },
				(_, row) =>
					terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true) ?? "",
			).join("\n");
		}
		return snapshots;
	} finally {
		terminal.dispose();
	}
}

function assertForegroundQuestionAndFooter(snapshots: Record<string, string>, root: string): void {
	const foreground = requireCapturedText(snapshots, "foregroundFocus");
	for (const marker of footer) assert.ok(foreground.includes(marker), "initial footer");
	const recovered = requireCapturedText(snapshots, "recovered");
	for (const marker of [question, answer, "Other", ...footer]) {
		assert.ok(recovered.includes(marker), `real pending UI recoverable: ${marker}`);
	}
	// Foreground emitted focus-in and never focus-out. Another attached client
	// must not strand its pending UI. No policy for a lone blurred client is asserted.
	for (const phase of ["shrink", "sameSizeWinch"]) {
		const snapshot = requireCapturedText(snapshots, phase);
		for (const marker of [question, answer, "Other", ...footer]) {
			assert.ok(
				snapshot.includes(marker),
				`foreground pending UI missing after ${phase}: ${marker}; artifacts=${root}\n${snapshots[phase]}`,
			);
		}
	}
}

for (const scenario of ["focused-control", "other-client-blur"]) {
	it(
		`native detach foreground keeps pending question and footer visible through resize: ${scenario}`,
		{ skip: !hasDtach && "requires native detach (set DTACH)", timeout: 20_000 },
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-dtach-focus-${scenario}-`));
			console.log(`dtach focus artifacts: ${root}`);
			const capture = runDtachScenario(root, scenario);
			assertSharedRuntimeAndAnswer(capture, scenario);
			const snapshots = await replayCapturedViewports(capture.captures);
			fs.writeFileSync(path.join(root, "viewports.json"), JSON.stringify(snapshots, null, 2));
			assertForegroundQuestionAndFooter(snapshots, root);
		},
	);
}
