import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../../../extensions/periodic-checks/src/index.ts";

const interval = 30 * 60 * 1000;
const checklistBody = "# Periodic checks\n\nReport current Git status and test failures. No edits.\n";
const checklistContent = configuredChecklist(1800);

function configuredChecklist(seconds) {
	return `---\ntype: Periodic Checks\ninterval_seconds: ${seconds}\n---\n${checklistBody}`;
}

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
}

function createProject(home, name) {
	const root = join(home, name);
	mkdirSync(root, { recursive: true });
	git(root, "init", "--quiet");
	writeFileSync(join(root, "periodic-checks.md"), checklistContent);
	return root;
}

async function fixture(t, overrides = {}, tools = ["spawn_agent", "send_agent_message"]) {
	const home = mkdtempSync(join(tmpdir(), "periodic-test-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const project = createProject(home, "first-project");
	const secondProject = createProject(home, "second-project");
	const checklist = join(project, "periodic-checks.md");
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1800000000000 });
	const handlers = new Map();
	const commands = new Map();
	const notifications = [];
	const calls = [];
	const messages = [];
	const agents = [];
	let spawn = async (params) => {
		const agent = {
			id: `audit-${calls.length}`,
			displayName: params.displayName,
			lifecycle: "running",
		};
		agents.push(agent);
		return {
			content: [{ type: "text", text: "Spawned audit" }],
			details: { agent, dispatched: true, prompt: params.prompt },
		};
	};
	const flush = async () => {
		await Promise.resolve();
		await Promise.resolve();
	};
	let idle = true;
	let pending = false;
	let sessionId = "main-session";
	const ctx = {
		cwd: project,
		ui: { notify: (text, type) => notifications.push({ text, type }) },
		mode: "tui",
		multiAgentAgentId: undefined,
		multiAgentRequiresAgentId: false,
		multiAgentStore: { listAgents: () => agents },
		sessionManager: { getSessionId: () => sessionId },
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		...overrides,
	};
	const pi = {
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		getActiveTools: () => tools,
		sendMessage: (message, options) => messages.push({ message, options }),
		callTool: (name, params) => {
			calls.push({ name, params });
			return spawn(params);
		},
	};
	extension(pi);
	const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
	t.after(() => assert.deepEqual(messages, [], "scheduler must not prompt main"));
	const finishAudit = () => {
		for (const agent of agents) agent.lifecycle = "completed";
	};
	return {
		calls,
		disableTools: () => tools.splice(0),
		messages,
		flush,
		setSpawn: (handler) => {
			spawn = handler;
		},
		notifications,
		status: async (args = "status") => {
			const command = commands.get("periodic-checks");
			assert.ok(command, "periodic-checks command must be registered");
			await command.handler(args, ctx);
			return notifications.at(-1).text;
		},
		agents,
		emit,
		finishAudit,
		ctx,
		home,
		project,
		secondProject,
		checklist,
		removeChecklist: () => rmSync(checklist),
		restoreChecklist: (content = checklistContent) => writeFileSync(checklist, content),
		tick: async (ms = interval) => {
			t.mock.timers.tick(ms);
			await flush();
		},
		busy: (value) => {
			idle = !value;
		},
		pending: (value) => {
			pending = value;
		},
		switchIdentity: (nextSessionId = "different-session") => {
			sessionId = nextSessionId;
		},
	};
}

export { fixture, interval, checklistBody, checklistContent, configuredChecklist, git };
