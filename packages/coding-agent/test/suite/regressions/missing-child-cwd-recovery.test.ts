import { join } from "node:path";
import { expect, it } from "vitest";
import { getControlDbPath } from "../../../src/core/session-control-db.ts";
import { MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { legacyMultiAgentStore } from "../../helpers/legacy-multi-agent-store.ts";
import { withHeadlessPi } from "../headless-pi.ts";

it("keeps selected-session startup alive when an attached child cwd was deleted", async () => {
	await withHeadlessPi(async (pi) => {
		const childSession = SessionManager.create("/deleted-child-cwd", pi.paths.sessionDir, {
			id: "missing-child-cwd-session",
		});
		childSession.appendMessage({ role: "user", content: "unfinished child work", timestamp: 1 });
		childSession.persistForRecovery();
		const childSessionFile = childSession.getSessionFile();
		if (!childSessionFile) throw new Error("Expected child session file");

		const parentSession = SessionManager.open(pi.sessionFile);
		parentSession.setMetadataControlDbPath(getControlDbPath(pi.paths.agentDir));
		const store = MultiAgentStore.fromSessionManager(parentSession);
		const missingCwd = join(pi.paths.tempDir, "deleted-child-worktree");
		const agent = legacyMultiAgentStore(store).spawnAgent({
			agentType: "verifier",
			cwd: missingCwd,
			displayName: "Interrupted verifier",
			origin: "attached",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: childSessionFile, sessionId: childSession.getSessionId() },
		}).agent;
		parentSession.appendCustomEntry("agent_start", {
			agentId: agent.id,
			childSessionId: childSession.getSessionId(),
			lifecycle: agent.lifecycle,
			transcriptPath: childSessionFile,
		});
		parentSession.persistForRecovery();

		expect(pi.listAgents()).toEqual(expect.arrayContaining([expect.objectContaining({ id: agent.id, lifecycle: "running" })]));
		expect(SessionManager.open(childSessionFile).getSessionId()).toBe(childSession.getSessionId());
		expect(SessionManager.open(pi.sessionFile).getEntries()).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "custom", customType: "agent_start" })]),
		);
		await pi.restart();
		await new Promise((resolve) => setTimeout(resolve, 1000));

		const agentsAfterRestart = pi.listAgents();
		const failed = agentsAfterRestart.find((candidate) => candidate.id === agent.id);
		expect(failed, JSON.stringify(agentsAfterRestart)).toMatchObject({ lifecycle: "failed" });
		expect(failed?.error?.message).toBe(`Agent ${agent.id} working directory does not exist: ${missingCwd}`);
	}, { model: false });
});
