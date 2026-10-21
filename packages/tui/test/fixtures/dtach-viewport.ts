import * as fs from "node:fs";
import { ProcessTerminal } from "../../src/terminal.ts";
import { CURSOR_MARKER, TUI } from "../../src/tui.ts";

const eventsPath = process.argv[2]!;
const terminal = new ProcessTerminal();
const tui = new TUI(terminal, true);
let updates = 0;
let renders = 0;
const record = (event: string): void => {
	fs.appendFileSync(
		eventsPath,
		`${JSON.stringify({
			event,
			pid: process.pid,
			columns: terminal.columns,
			rows: terminal.rows,
			renders,
			winchListeners: process.listenerCount("SIGWINCH"),
			resizeListeners: process.stdout.listenerCount("resize"),
		})}\n`,
	);
};

tui.addChild({
	render() {
		renders++;
		return [...Array.from({ length: 15 }, (_, i) => `content ${i}`), `update ${updates}${CURSOR_MARKER}`];
	},
	invalidate() {},
});
tui.addInputListener((data) => {
	if (data === "u") {
		updates++;
		tui.requestRender();
	}
	if (data === "s") tui.stop();
	if (data === "q") {
		tui.stop();
		process.exit(0);
	}
	setTimeout(() => record(`input:${data}`), 70);
	return { consume: true };
});
process.on("SIGWINCH", () => setTimeout(() => record("SIGWINCH"), 70));
process.stdout.on("resize", () => setTimeout(() => record("stdout:resize"), 70));
process.on("SIGUSR1", () => {
	tui.start();
	setTimeout(() => record("restarted"), 100);
});
// Keep the child alive while testing stop/start listener ownership.
setInterval(() => {}, 1000);
record("baseline");
tui.start();
setTimeout(() => record("ready"), 150);
