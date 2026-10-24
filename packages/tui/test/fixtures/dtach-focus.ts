import * as fs from "node:fs";
import { KeybindingsManager } from "../../../coding-agent/src/core/keybindings.ts";
import { createAskQuestionsPanel } from "../../../coding-agent/src/core/tools/ask-questions-panel.ts";
import { loadThemeFromPath } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { Text } from "../../src/components/text.ts";
import { setKeybindings } from "../../src/keybindings.ts";
import { ProcessTerminal } from "../../src/terminal.ts";
import { Container, TUI } from "../../src/tui.ts";

const eventsPath = process.argv[2];
if (eventsPath === undefined) {
	throw new Error("dtach-focus fixture requires an events output path as argv[2]");
}
const terminal = new ProcessTerminal();
const tui = new TUI(terminal);
const keybindings = new KeybindingsManager();
setKeybindings(keybindings);
const theme = loadThemeFromPath(
	new URL("../../../coding-agent/src/modes/interactive/theme/dark.json", import.meta.url).pathname,
);
const record = (event: string, result?: unknown): void => {
	fs.appendFileSync(
		eventsPath,
		`${JSON.stringify({
			event,
			pid: process.pid,
			execPath: process.execPath,
			runtime: process.versions.bun ? "bun" : "node",
			columns: terminal.columns,
			rows: terminal.rows,
			result,
		})}\n`,
	);
};

const questionContainer = new Container();
const footer = new Text("FOCUS_TEST_WORKSPACE /isolated/workspace\nFOCUS_TEST_MODEL offline-no-provider", 0, 0);
tui.addChild(new Text(Array.from({ length: 70 }, (_, i) => `Prior response line ${i}`).join("\n"), 0, 0));
tui.addChild(questionContainer);
tui.addChild(footer);
tui.addInputListener((data) => {
	if (data !== "m") return undefined;
	const panel = createAskQuestionsPanel({
		questions: [
			{
				question: "Which foreground regression should stay visible?",
				options: [{ label: "Keep attached PTY coverage" }, { label: "Keep focus controls" }],
			},
		],
		theme,
		keybindings,
		requestRender: () => tui.requestRender(),
		done: (result) => record("answered", result),
	});
	questionContainer.addChild(panel);
	tui.setFocus(panel);
	tui.requestRender();
	setTimeout(() => record("mounted"), 100);
	return { consume: true };
});
process.on("SIGWINCH", () => setTimeout(() => record("winch"), 100));
process.on("SIGTERM", () => {
	tui.stop();
	process.exit(0);
});
tui.start();
// Observe transport arrival, not TUI private state or rendering method calls.
process.stdin.on("data", (data: string) => setTimeout(() => record(`received:${data}`), 100));
setTimeout(() => record("ready"), 200);
