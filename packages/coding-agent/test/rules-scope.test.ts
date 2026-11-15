import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { MultiAgentRuntimeRole } from "../src/core/agent-session-capabilities.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

/** The <user_rules> block of a session created with one rule file in each scope directory. */
async function sessionRules(options: {
	role?: MultiAgentRuntimeRole;
	supervisorSessionId?: (sessionId: string) => string;
}): Promise<string | undefined> {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-rules-scope-"));
	tempDirs.push(agentDir);
	for (const dir of ["main", "sub-agent", "supervisor"]) {
		mkdirSync(join(agentDir, "rules", dir), { recursive: true });
		writeFileSync(join(agentDir, "rules", dir, "rule.md"), `${dir} rule`);
	}
	writeFileSync(join(agentDir, "rules", "shared.md"), "shared rule");
	const model = getModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected test model");
	const sessionManager = SessionManager.inMemory(agentDir);
	const supervisorSessionId = options.supervisorSessionId?.(sessionManager.getSessionId());
	const { session } = await createAgentSession({
		agentDir,
		cwd: agentDir,
		model,
		multiAgentRuntimeRole: options.role,
		sessionManager,
		settingsManager: SettingsManager.inMemory(
			supervisorSessionId ? { supervisor: { sessionId: supervisorSessionId } } : {},
		),
	});
	try {
		return /<user_rules>\n([\s\S]*?)\n<\/user_rules>/.exec(session.systemPrompt)?.[1];
	} finally {
		session.dispose();
	}
}

describe("rules scope selection", () => {
	it("loads main and supervisor rules for the configured Supervisor session", async () => {
		expect(await sessionRules({ supervisorSessionId: (id) => id })).toBe(
			"shared rule\n\nmain rule\n\nsupervisor rule",
		);
	});

	it("loads only main rules for a main session that is not the Supervisor", async () => {
		expect(await sessionRules({ supervisorSessionId: () => "another-session" })).toBe("shared rule\n\nmain rule");
	});

	it("loads sub-agent rules for a child runtime, even with the Supervisor's session ID", async () => {
		expect(await sessionRules({ role: "child", supervisorSessionId: (id) => id })).toBe(
			"shared rule\n\nsub-agent rule",
		);
	});
});
