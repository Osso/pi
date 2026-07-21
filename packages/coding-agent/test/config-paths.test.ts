import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ENV_AGENT_DIR,
	ENV_STATE_DIR,
	getAgentDir,
	getLegacyAgentDir,
	getUserConfigRoot,
	getUserStateRoot,
} from "../src/config.ts";
import { enqueueIncomingMessage, getControlDbPath } from "../src/core/session-control-db.ts";

describe("config paths", () => {
	const temporaryDirectories: string[] = [];
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	const previousStateDir = process.env[ENV_STATE_DIR];
	const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
	const previousXdgStateHome = process.env.XDG_STATE_HOME;

	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, { force: true, recursive: true });
		}
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		if (previousStateDir === undefined) {
			delete process.env[ENV_STATE_DIR];
		} else {
			process.env[ENV_STATE_DIR] = previousStateDir;
		}
		if (previousXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
		}
		if (previousXdgStateHome === undefined) {
			delete process.env.XDG_STATE_HOME;
		} else {
			process.env.XDG_STATE_HOME = previousXdgStateHome;
		}
	});

	it("uses the XDG config root for the default agent dir", () => {
		delete process.env[ENV_AGENT_DIR];
		process.env.XDG_CONFIG_HOME = "/tmp/pi-xdg-config";

		expect(getUserConfigRoot()).toBe(join("/tmp/pi-xdg-config", "pi"));
		expect(getAgentDir()).toBe(join("/tmp/pi-xdg-config", "pi", "agent"));
	});

	it("falls back to ~/.config/pi when XDG_CONFIG_HOME is unset", () => {
		delete process.env[ENV_AGENT_DIR];
		delete process.env.XDG_CONFIG_HOME;

		expect(getUserConfigRoot()).toBe(join(homedir(), ".config", "pi"));
		expect(getAgentDir()).toBe(join(homedir(), ".config", "pi", "agent"));
	});

	it("keeps the explicit agent dir override ahead of the XDG default", () => {
		process.env[ENV_AGENT_DIR] = "~/custom-pi-agent";
		process.env.XDG_CONFIG_HOME = "/tmp/pi-xdg-config";

		expect(getAgentDir()).toBe(join(homedir(), "custom-pi-agent"));
	});

	it("uses the XDG state root for runtime state", () => {
		delete process.env[ENV_STATE_DIR];
		process.env.XDG_STATE_HOME = "/tmp/pi-xdg-state";

		expect(getUserStateRoot()).toBe(join("/tmp/pi-xdg-state", "pi"));
	});

	it("falls back to ~/.local/state/pi when XDG_STATE_HOME is unset", () => {
		delete process.env[ENV_STATE_DIR];
		delete process.env.XDG_STATE_HOME;

		expect(getUserStateRoot()).toBe(join(homedir(), ".local", "state", "pi"));
	});

	it("keeps the explicit state dir override ahead of the XDG default", () => {
		process.env[ENV_STATE_DIR] = "~/custom-pi-state";
		process.env.XDG_STATE_HOME = "/tmp/pi-xdg-state";

		expect(getUserStateRoot()).toBe(join(homedir(), "custom-pi-state"));
	});

	it("stores the configured runtime control database under the state root", () => {
		process.env[ENV_AGENT_DIR] = "/tmp/pi-agent-config";
		process.env[ENV_STATE_DIR] = "/tmp/pi-runtime-state";

		expect(getControlDbPath()).toBe(join("/tmp/pi-runtime-state", "control.sqlite"));
	});

	it("allows explicit isolated control database directories", () => {
		process.env[ENV_AGENT_DIR] = "/tmp/pi-agent-config";
		process.env[ENV_STATE_DIR] = "/tmp/pi-runtime-state";

		expect(getControlDbPath("/tmp/pi-test-state")).toBe(join("/tmp/pi-test-state", "control.sqlite"));
	});

	it("creates a missing state directory before opening the control database", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-control-state-"));
		temporaryDirectories.push(tempDir);
		process.env[ENV_AGENT_DIR] = join(tempDir, "config", "agent");
		process.env[ENV_STATE_DIR] = join(tempDir, "missing", "state");
		const controlDbPath = getControlDbPath();

		enqueueIncomingMessage(controlDbPath, "test");

		expect(existsSync(controlDbPath)).toBe(true);
	});

	it("keeps the legacy ~/.pi/agent path available for migration tooling", () => {
		expect(getLegacyAgentDir()).toBe(join(homedir(), ".pi", "agent"));
	});
});
