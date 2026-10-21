import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";
import { CURSOR_MARKER, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const markers = Array.from({ length: 30 }, (_, index) => `SSH_HISTORY_${index}`);

it("same-size resize restores only the visible viewport and keeps differential updates aligned", async () => {
	const terminal = new VirtualTerminal(40, 10);
	const tui = new TUI(terminal, true);
	let update = 0;
	tui.addChild({
		render: () => [...Array.from({ length: 15 }, (_, i) => `content ${i}`), `update ${update}${CURSOR_MARKER}`],
		invalidate() {},
	});
	terminal.write(`${markers.join("\r\n")}\r\n${"\r\n".repeat(10)}\x1b[H`);
	tui.start();
	try {
		await terminal.waitForRender();
		const history = terminal.getScrollBuffer().slice(0, -10);
		for (let index = 0; index < 2; index++) {
			terminal.write("\x1b[H\x1b[J");
			terminal.resize(40, 10);
			await terminal.waitForRender();
			assert.deepEqual(terminal.getViewport(), [
				...Array.from({ length: 9 }, (_, i) => `content ${i + 6}`),
				`update ${update}`,
			]);
			assert.deepEqual(terminal.getScrollBuffer().slice(0, -10), history);
			assert.deepEqual(terminal.getCursorPosition(), { x: 8, y: 9 });
			update++;
			tui.requestRender();
			await terminal.waitForRender();
			assert.equal(terminal.getViewport()[9], `update ${update}`);
			assert.deepEqual(terminal.getCursorPosition(), { x: 8, y: 9 });
			assert.deepEqual(terminal.getScrollBuffer().slice(0, -10), history);
		}
	} finally {
		tui.stop();
	}
});

type Event = {
	event: string;
	pid: number;
	columns: number;
	rows: number;
	renders: number;
	winchListeners: number;
	resizeListeners: number;
};
type Capture = { captures: Record<string, string>; events: Event[] };
const dtach = process.env.DTACH ?? "dtach";
const hasDtach = process.platform !== "win32" && spawnSync(dtach, ["-v"]).error === undefined;

it(
	"native dtach same-size SIGWINCH restores viewport, scrollback, cursor, and listener lifecycle",
	{
		skip: !hasDtach && "requires native dtach (set DTACH to its executable)",
		timeout: 20000,
	},
	async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dtach-viewport-"));
		const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
		try {
			const result = spawnSync(
				"python3",
				[
					path.join(fixtures, "dtach-viewport.py"),
					root,
					dtach,
					process.execPath,
					path.join(fixtures, "dtach-viewport.ts"),
				],
				{
					encoding: "utf8",
					timeout: 15000,
				},
			);
			assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}\n${result.stdout}`);
			const { captures, events } = JSON.parse(result.stdout) as Capture;
			const terminal = new xterm.Terminal({ cols: 40, rows: 10, scrollback: 1000, allowProposedApi: true });
			const write = (data: string): Promise<void> => new Promise((resolve) => terminal.write(data, resolve));
			const viewport = (): string[] =>
				Array.from(
					{ length: terminal.rows },
					(_, i) =>
						terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) ?? "",
				);
			const history = (): string[] =>
				Array.from(
					{ length: terminal.buffer.active.viewportY },
					(_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? "",
				);
			const assertCursor = (): void => {
				assert.equal(terminal.buffer.active.cursorX, 8);
				assert.equal(terminal.buffer.active.cursorY, 9);
			};
			try {
				await write(`${markers.join("\r\n")}\r\n${"\r\n".repeat(10)}\x1b[H`);
				await write(captures.initial!);
				const seededHistory = history();
				assert.deepEqual(
					seededHistory.filter((line) => line.startsWith("SSH_HISTORY_")),
					markers,
				);
				for (let index = 0; index < 2; index++) {
					await write(captures[`attach${index}`]!);
					assert.deepEqual(viewport(), [
						...Array.from({ length: 9 }, (_, i) => `content ${i + 6}`),
						`update ${index}`,
					]);
					assert.deepEqual(history(), seededHistory);
					assertCursor();
					await write(captures[`update${index}`]!);
					assert.equal(viewport()[9], `update ${index + 1}`);
					assert.deepEqual(history(), seededHistory);
					assertCursor();
				}
				terminal.resize(41, 10);
				await write(captures.changed!);
				assert.equal(viewport()[9], "update 2");
				assertCursor();
				assert.deepEqual(
					history().filter((line) => line.startsWith("SSH_HISTORY_")),
					[],
					"changed-size behavior remains unchanged",
				);
			} finally {
				terminal.dispose();
			}
			const baseline = events.find((event) => event.event === "baseline")!;
			const ready = events.find((event) => event.event === "ready")!;
			const stopped = events.find((event) => event.event === "input:s")!;
			const restarted = events.find((event) => event.event === "restarted")!;
			assert.equal(ready.winchListeners, baseline.winchListeners + 1);
			assert.equal(ready.resizeListeners, baseline.resizeListeners + 1);
			assert.equal(stopped.winchListeners, baseline.winchListeners);
			assert.equal(stopped.resizeListeners, baseline.resizeListeners);
			assert.equal(restarted.winchListeners, ready.winchListeners);
			assert.equal(restarted.resizeListeners, ready.resizeListeners);
			assert.equal(events[events.indexOf(stopped) + 1]!.renders, stopped.renders);
			assert.equal(events.at(-1)!.renders, restarted.renders + 1);
			assert.equal(new Set(events.map((event) => event.pid)).size, 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	},
);
