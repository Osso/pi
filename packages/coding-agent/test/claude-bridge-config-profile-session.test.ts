import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { prepareAccountProfile, readUsageCredentials } from "../extensions/claude-bridge/src/account-profiles.ts";
import { loadConfig } from "../extensions/claude-bridge/src/config.ts";
import { verifyWrittenSession } from "../extensions/claude-bridge/src/session-verify.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function makeTempDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

describe("claude bridge config", () => {
	it("merges project settings over global settings in the isolated Pi agent directory", () => {
		const home = makeTempDirectory("bridge-config-home-");
		const agentDir = join(home, "agent");
		const cwd = join(home, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		writeFileSync(
			join(agentDir, "claude-bridge.json"),
			JSON.stringify({
				provider: { plan: "pro", strictMcpConfig: true },
				askClaude: { enabled: true, defaultMode: "read" },
			}),
		);
		writeFileSync(
			join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"),
			JSON.stringify({ provider: { plan: "max" }, askClaude: { enabled: false } }),
		);

		expect(loadConfig(cwd)).toEqual({
			startupNoticeShown: undefined,
			provider: { plan: "max", strictMcpConfig: true },
			askClaude: { enabled: false, defaultMode: "read" },
		});
	});
});

describe("claude bridge account profiles", () => {
	it("adopts only synthetic named credentials into a private isolated profile", () => {
		const home = makeTempDirectory("bridge-profile-home-");
		const claudeDir = join(home, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "agent"));
		const credentials = JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-fixture-token" } });
		writeFileSync(join(claudeDir, "alpha.credentials.json"), credentials);

		const profileDir = prepareAccountProfile(home, "alpha");
		const canonicalCredentials = join(profileDir, ".credentials.json");
		expect(readFileSync(canonicalCredentials, "utf8")).toBe(credentials);
		expect(readUsageCredentials(home, "alpha")).toEqual(JSON.parse(credentials));
		expect(readFileSync(join(profileDir, ".credential-owner"), "utf8")).toBe("shared-v1\n");
		expect(statSync(profileDir).mode & 0o777).toBe(0o700);
		expect(statSync(canonicalCredentials).mode & 0o777).toBe(0o600);
	});

	it("rejects malformed synthetic credentials without replacing them", () => {
		const home = makeTempDirectory("bridge-invalid-profile-");
		const claudeDir = join(home, ".claude");
		const profileDir = join(home, ".config", "pi-claude-bridge", "profiles", "alpha");
		vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "agent"));
		mkdirSync(claudeDir, { recursive: true });
		mkdirSync(profileDir, { recursive: true });
		const malformed = "{ invalid fixture";
		writeFileSync(join(claudeDir, "alpha.credentials.json"), malformed);

		expect(() => prepareAccountProfile(home, "alpha")).toThrow(/Invalid credentials/);
		expect(readFileSync(join(claudeDir, "alpha.credentials.json"), "utf8")).toBe(malformed);
		expect(existsSync(join(profileDir, ".credentials.json"))).toBe(false);
	});
});

describe("claude bridge session verification", () => {
	it("accepts a saved session with matching identity and record count", () => {
		const directory = makeTempDirectory("bridge-session-");
		const sessionPath = join(directory, "session.jsonl");
		const records = [
			{ sessionId: "session-fixture", type: "session", id: "session-fixture" },
			{ sessionId: "session-fixture", type: "message", message: { role: "user", content: "fixture" } },
		];
		writeFileSync(sessionPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

		expect(verifyWrittenSession(sessionPath, "session-fixture", records.length)).toEqual([]);
		expect(verifyWrittenSession(sessionPath, "other-session", records.length)).toEqual([
			expect.stringContaining("sessionId drift"),
		]);
	});
});
