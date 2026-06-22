import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, getAgentDir, getLegacyAgentDir, getUserConfigRoot } from "../src/config.ts";

describe("config paths", () => {
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		if (previousXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
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

	it("keeps the legacy ~/.pi/agent path available for migration tooling", () => {
		expect(getLegacyAgentDir()).toBe(join(homedir(), ".pi", "agent"));
	});
});
