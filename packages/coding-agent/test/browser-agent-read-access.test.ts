import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createProductionAttachedSessionFactory,
	createProductionChildAgentSessionFactory,
} from "../extensions/agents-core/src/runtime.ts";
import agentsMailboxExtension from "../extensions/agents-mailbox/src/index.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { defineTool, type ExtensionFactory, type ToolDefinition } from "../src/core/extensions/types.ts";
import type { AgentSnapshot } from "../src/core/multi-agent-store.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const FILE_CONTENT = "browser instructions\n";
const RULES_CONTENT = "global rules\n";
const EXPECTED_BROWSER_TOOLS = ["browser-cli", "contact_parent", "end_turn", "read", "send_agent_message"];

interface ReadAccessFixture {
	agentConfigRoot: string;
	aliasPath: string;
	canonicalPath: string;
	escapePath: string;
	outsidePath: string;
	rulesPath: string;
	workspace: string;
}

interface ProfileChild {
	session: AgentSession;
}

const cleanupCallbacks: Array<() => void> = [];
let fixture: ReadAccessFixture;

beforeEach(() => {
	const workspace = mkdtempSync(join(tmpdir(), "pi-browser-read-"));
	const agentConfigRoot = join(workspace, "AgentConfig");
	const canonicalPath = join(agentConfigRoot, "skills", "browser-cli", "SKILL.md");
	const aliasPath = join(workspace, ".config", "pi", "agent", "skills", "browser-cli", "SKILL.md");
	const outsidePath = join(workspace, "AgentConfig-outside", "outside.md");
	const escapePath = join(agentConfigRoot, "skills", "browser-cli", "escape.md");
	const rulesPath = join(agentConfigRoot, "rules", "global.md");

	mkdirSync(dirname(canonicalPath), { recursive: true });
	mkdirSync(dirname(outsidePath), { recursive: true });
	mkdirSync(dirname(rulesPath), { recursive: true });
	mkdirSync(dirname(dirname(dirname(aliasPath))), { recursive: true });
	writeFileSync(canonicalPath, FILE_CONTENT);
	writeFileSync(outsidePath, "outside\n");
	writeFileSync(rulesPath, RULES_CONTENT);
	symlinkSync(join(agentConfigRoot, "skills"), join(workspace, ".config", "pi", "agent", "skills"), "dir");
	symlinkSync(outsidePath, escapePath);

	fixture = { agentConfigRoot, aliasPath, canonicalPath, escapePath, outsidePath, rulesPath, workspace };
	cleanupCallbacks.push(() => rmSync(workspace, { force: true, recursive: true }));
});

afterEach(() => {
	for (const cleanup of cleanupCallbacks.splice(0).reverse()) cleanup();
});

function createAgent(agentType: string, cwd: string): AgentSnapshot {
	return {
		agentType,
		createdAt: "2026-08-23T00:00:00.000Z",
		cwd,
		displayName: `${agentType} child`,
		id: `${agentType}-child`,
		lifecycle: "running",
		parentId: "main",
		permission: { narrowed: true, policy: "on-request" },
		revision: 1,
		updatedAt: "2026-08-23T00:00:00.000Z",
	};
}

const browserCliExtension: ExtensionFactory = (pi) => {
	pi.registerTool(
		defineTool({
			name: "browser-cli",
			label: "Browser CLI",
			description: "Test browser tool",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "browser" }], details: {} }),
		}),
	);
};

function createMailboxExtension(store: MultiAgentStore): ExtensionFactory {
	return (pi) => agentsMailboxExtension(pi, { store });
}

function createSessionFactory(
	parentHarness: Harness,
	childSessions: AgentSession[],
): (options: CreateAgentSessionOptions) => Promise<{ session: AgentSession }> {
	return async (options) => {
		const extensionsResult = await createTestExtensionsResult(
			options.extensionFactories ?? [],
			parentHarness.tempDir,
		);
		const result = await createAgentSession({
			...options,
			authStorage: parentHarness.authStorage,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			settingsManager: parentHarness.settingsManager,
		});
		childSessions.push(result.session);
		return { session: result.session };
	};
}

async function createProfileChild(agentType: string, attached = false): Promise<ProfileChild> {
	const parentHarness = await createHarness({
		persistedSession: true,
		settings: { agents: { browser: { tools: ["browser-cli"] } } },
	});
	const childSessions: AgentSession[] = [];
	cleanupCallbacks.push(() => {
		for (const session of childSessions) session.dispose();
		parentHarness.cleanup();
	});

	const store = new MultiAgentStore();
	const createSession = createSessionFactory(parentHarness, childSessions);
	const extensionFactories: ExtensionFactory[] = [browserCliExtension, createMailboxExtension(store)];
	const factoryOptions = {
		agentDir: join(fixture.workspace, ".config", "pi", "agent"),
		browserAgentConfigRoot: fixture.agentConfigRoot,
		createSession,
		extensionFactories,
		multiAgentStore: store,
	};
	const agent = createAgent(agentType, parentHarness.tempDir);
	if (attached) {
		const persistedSession = SessionManager.create(
			parentHarness.tempDir,
			parentHarness.sessionManager.getSessionDir(),
			{
				isSubagent: true,
				parentSession: parentHarness.sessionManager.getSessionId(),
				subagentName: agent.displayName,
			},
		);
		persistedSession.appendMessage({ role: "user", content: "Persisted browser task", timestamp: 1 });
		persistedSession.persistForRecovery();
		const sessionPath = persistedSession.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted child session path");
		await createProductionAttachedSessionFactory(factoryOptions)({
			agent: { ...agent, transcript: { path: sessionPath, sessionId: persistedSession.getSessionId() } },
			ctx: parentHarness.session.extensionRunner.createContext(),
			prompt: "Resume browser task",
			sessionPath,
		});
	} else {
		await createProductionChildAgentSessionFactory({
			...factoryOptions,
			createSessionManager: SessionManager.create,
		})({
			agent,
			context: "fresh",
			ctx: parentHarness.session.extensionRunner.createContext(),
			prompt: "Read the requested file",
		});
	}
	const session = childSessions[0];
	if (!session) throw new Error("Expected production child session");
	return { session };
}

function requireReadTool(session: AgentSession): ToolDefinition {
	expect(session.getActiveToolNames()).toContain("read");
	const readTool = session.getToolDefinition("read");
	if (!readTool) throw new Error("Expected active read tool");
	return readTool;
}

async function executeRead(session: AgentSession, readTool: ToolDefinition, path: string): Promise<string> {
	const result = await readTool.execute(
		"browser-read-access",
		{ path },
		undefined,
		undefined,
		session.extensionRunner.createContext(),
	);
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function expectBrowserToolInventory(session: AgentSession): void {
	expect([...session.getActiveToolNames()].sort()).toEqual([...EXPECTED_BROWSER_TOOLS].sort());
}

describe("browser-agent read access", () => {
	it("reads files anywhere under AgentConfig", async () => {
		const { session } = await createProfileChild("browser");
		const output = await executeRead(session, requireReadTool(session), fixture.rulesPath);

		expect(output).toBe(RULES_CONTENT);
		expectBrowserToolInventory(session);
	});

	it("reads AgentConfig files through the pi skills symlink alias", async () => {
		const { session } = await createProfileChild("browser");
		const output = await executeRead(session, requireReadTool(session), fixture.aliasPath);

		expect(output).toBe(FILE_CONTENT);
	});

	it("rejects ordinary paths outside AgentConfig", async () => {
		const { session } = await createProfileChild("browser");
		const readTool = requireReadTool(session);

		await expect(executeRead(session, readTool, fixture.outsidePath)).rejects.toThrow(
			/Read access denied: .* resolves outside allowed roots/,
		);
	});

	it("rejects symlinks under AgentConfig whose realpath escapes the allowed root", async () => {
		const { session } = await createProfileChild("browser");
		const readTool = requireReadTool(session);

		await expect(executeRead(session, readTool, fixture.escapePath)).rejects.toThrow(
			/Read access denied: .* resolves outside allowed roots/,
		);
	});

	it("applies the same restricted read tool to attached browser sessions", async () => {
		const { session } = await createProfileChild("browser", true);
		const readTool = requireReadTool(session);

		await expect(executeRead(session, readTool, fixture.outsidePath)).rejects.toThrow(
			/Read access denied: .* resolves outside allowed roots/,
		);
		expect(await executeRead(session, readTool, fixture.canonicalPath)).toBe(FILE_CONTENT);
		expectBrowserToolInventory(session);
	});

	it("keeps ordinary read access unchanged for main and non-browser profiles", async () => {
		const mainHarness = await createHarness();
		cleanupCallbacks.push(mainHarness.cleanup);
		const { session: exploreSession } = await createProfileChild("explore");

		const mainOutput = await executeRead(
			mainHarness.session,
			requireReadTool(mainHarness.session),
			fixture.outsidePath,
		);
		const exploreOutput = await executeRead(exploreSession, requireReadTool(exploreSession), fixture.outsidePath);

		expect(mainOutput).toBe("outside\n");
		expect(exploreOutput).toBe("outside\n");
	});
});
