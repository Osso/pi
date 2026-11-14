import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sendAgentMessage } from "../extensions/agents-core/src/messaging.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { listRuntimeMailboxMessages } from "../src/core/session-control-db/runtime-mailbox-status.ts";
import { getControlDbPath } from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { legacyMultiAgentStore } from "./helpers/legacy-multi-agent-store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("send_agent_message from a main-thread child", () => {
	it("delivers to the main parent without toSessionId", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-child-to-main-"));
		tempDirs.push(dir);
		const controlDbPath = getControlDbPath(dir);
		const session = SessionManager.create("/repo", dir);
		session.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-11-14T00:00:00.000Z" });
		store.setPersistenceSessionManager(session);
		const child = legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			permission: { narrowed: true, policy: "on-request" },
		});
		const ctx = {
			controlDbPath,
			multiAgentAgentId: child.agent.id,
			multiAgentParentSessionId: session.getSessionId(),
			sessionManager: session,
		} as unknown as ExtensionContext;

		const sent = sendAgentMessage(store, { message: "direct parent route", toAgentId: "main" }, ctx);

		expect(sent.content).toEqual([{ type: "text", text: "Sent message to main." }]);
		expect(sent.details.message).toMatchObject({
			body: "direct parent route",
			fromAgentId: child.agent.id,
			status: "pending",
			toAgentId: "main",
		});
		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{ recipient: { agentId: null, sessionId: session.getSessionId() }, sender: { agentId: child.agent.id } },
		]);
	});

	it("still rejects main as a target for a nested child", () => {
		const store = new MultiAgentStore({ now: () => "2026-11-14T00:00:00.000Z" });
		const parent = legacyMultiAgentStore(store).spawnAgent({
			agentType: "lead",
			cwd: "/repo",
			displayName: "Lead",
			permission: { narrowed: true, policy: "on-request" },
		});
		const nested = legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Nested",
			parentId: parent.agent.id,
			permission: { narrowed: true, policy: "on-request" },
		});

		const sent = store.sendMailboxMessage(nested.agent.id, nested.agent.revision, {
			body: "skip my parent",
			toAgentId: "main",
		});

		expect(sent).toMatchObject({ ok: false, error: "target_not_found" });
	});
});
