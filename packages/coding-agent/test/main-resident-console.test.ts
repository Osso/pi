import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as StartupUiModule from "../src/cli/startup-ui.ts";
import { ResidentConsoleServer } from "../src/core/resident-console-transport.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const startupUiMock = vi.hoisted(() => ({
	ui: {
		addChild: vi.fn(),
		requestRender: vi.fn(),
		setFocus: vi.fn(),
		stop: vi.fn(),
	},
}));

vi.mock("../src/cli/startup-ui.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof StartupUiModule>();
	return {
		...actual,
		createStartupTui: vi.fn(() => startupUiMock.ui as unknown as TUI),
		startStartupTui: vi.fn(),
	};
});

import { main } from "../src/main.ts";

const temporaryDirectories: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalStateDir = process.env.PI_CODING_AGENT_STATE_DIR;
const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;

beforeAll(() => initTheme("dark"));

afterEach(() => {
	process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	process.env.PI_CODING_AGENT_STATE_DIR = originalStateDir;
	Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalStdinIsTTY });
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalStdoutIsTTY });
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
	vi.clearAllMocks();
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

describe("main resident console dispatch", () => {
	it("connects --supervisor to the resident transport without ordinary AgentSession startup", async () => {
		const stateDir = temporaryDirectory("pi-supervisor-cli-state-");
		process.env.PI_CODING_AGENT_DIR = temporaryDirectory("pi-supervisor-cli-agent-");
		process.env.PI_CODING_AGENT_STATE_DIR = stateDir;
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		let submittedPrompt: string | undefined;
		const server = new ResidentConsoleServer({
			socketPath: join(stateDir, "control.sqlite.supervisor-console.sock"),
			service: "supervisor",
			getSnapshot: () => ({
				service: "supervisor",
				sessionId: "resident-supervisor",
				cwd: "/resident-kb",
				generation: 42,
				branch: [],
			}),
			enqueuePrompt: (text) => {
				submittedPrompt = text;
			},
			subscribe: () => () => {},
		});
		await server.start();

		const command = main(["--supervisor", "inspect", "this"]);
		await vi.waitFor(() => expect(submittedPrompt).toBe("inspect this"));
		await server.close();
		await command;

		expect(startupUiMock.ui.addChild).toHaveBeenCalledOnce();
		expect(startupUiMock.ui.setFocus).toHaveBeenCalledOnce();
	});
});
