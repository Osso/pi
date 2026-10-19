import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionMessageRouteError } from "../extensions/agents-core/src/session-message-route.ts";
import { getControlDbPath, registerRuntimeMailboxListener } from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";

let directory: string;
let controlDbPath: string;
let sessionId: string;
const childId = "agent_route_child";

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-session-route-"));
	controlDbPath = getControlDbPath(directory);
	const session = SessionManager.create(directory, join(directory, "sessions"));
	session.setMetadataControlDbPath(controlDbPath);
	session.persistForRecovery();
	sessionId = session.getSessionId();
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("local main-thread session routing", () => {
	it.each(["main", "supervisor"])("rejects %s when only the child listener owns the session", (toAgentId) => {
		registerRuntimeMailboxListener(controlDbPath, { sessionId, agentId: childId }, process.pid);
		const error = sessionMessageRouteError(controlDbPath, {
			message: "approval",
			toAgentId,
			toSessionId: sessionId,
			toHost: toAgentId === "supervisor" ? hostname() : undefined,
		});
		expect(error).toContain(sessionId);
		expect(error).toContain(childId);
	});

	it("preserves a main listener even when the same session has a child listener", () => {
		registerRuntimeMailboxListener(controlDbPath, { sessionId, agentId: childId }, process.pid);
		registerRuntimeMailboxListener(controlDbPath, { sessionId, agentId: null }, process.pid);
		expect(
			sessionMessageRouteError(controlDbPath, { message: "main inbox", toAgentId: "main", toSessionId: sessionId }),
		).toBeUndefined();
	});

	it("does not apply the local child check to an explicit remote destination or agent ID", () => {
		registerRuntimeMailboxListener(controlDbPath, { sessionId, agentId: childId }, process.pid);
		expect(
			sessionMessageRouteError(controlDbPath, {
				message: "remote inbox",
				toAgentId: "main",
				toSessionId: sessionId,
				toHost: `${hostname()}-peer`,
			}),
		).toBeUndefined();
		expect(
			sessionMessageRouteError(controlDbPath, {
				message: "child inbox",
				toAgentId: childId,
				toSessionId: sessionId,
			}),
		).toBeUndefined();
	});
});
