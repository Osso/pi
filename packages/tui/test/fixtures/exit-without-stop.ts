import { Text } from "../../src/components/text.ts";
import { ProcessTerminal } from "../../src/terminal.ts";
import { TUI } from "../../src/tui.ts";

// Exits the way an extension or fatal error path does: process.exit() without tui.stop().
const tui = new TUI(new ProcessTerminal());
tui.addChild(new Text("running", 0, 0));
tui.start();
setTimeout(() => process.exit(3), 500);
