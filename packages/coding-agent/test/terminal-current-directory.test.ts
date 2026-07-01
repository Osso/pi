import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import { formatTerminalCurrentDirectorySequence } from "../src/utils/terminal-current-directory.ts";

describe("formatTerminalCurrentDirectorySequence", () => {
	it("formats an OSC 7 file URI with local hostname for the session cwd", () => {
		expect(formatTerminalCurrentDirectorySequence("/syncthing/Sync/Projects/wow/wow-ui-sim")).toBe(
			`\x1b]7;file://${hostname()}/syncthing/Sync/Projects/wow/wow-ui-sim\x1b\\`,
		);
	});

	it("percent-encodes cwd characters that are not valid in file URIs", () => {
		expect(formatTerminalCurrentDirectorySequence("/tmp/project with spaces/#branch")).toBe(
			`\x1b]7;file://${hostname()}/tmp/project%20with%20spaces/%23branch\x1b\\`,
		);
	});
});
