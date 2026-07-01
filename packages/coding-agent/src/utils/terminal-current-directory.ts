import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

/**
 * OSC 7 announces the logical current directory to terminals so actions such as
 * opening a new tab can inherit the application-level cwd instead of the parent
 * shell process cwd.
 */
export function formatTerminalCurrentDirectorySequence(cwd: string): string {
	const cwdUrl = pathToFileURL(cwd);
	cwdUrl.hostname = hostname();
	return `\x1b]7;${cwdUrl.href}\x1b\\`;
}
