import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, ENV_STATE_DIR } from "../../src/config.ts";
import { probeResidentConsole } from "../../src/core/resident-console-transport.ts";
import { getControlDbPath, postSupervisorRequest, readSupervisorRequest } from "../../src/core/session-control-db.ts";
import {
	createSupervisorInstructionEvaluator,
	createSupervisorModelRegistry,
	createSupervisorResourceLoader,
	createSupervisorSettingsManager,
} from "../../src/supervisor/main.ts";
import { notifySupervisorRequest } from "../../src/supervisor/request-wake.ts";

const EXTENSION_PATH = join(import.meta.dirname, "fixtures", "supervisor-extension-provider.ts");
const UNRELATED_EXTENSION_PATH = join(import.meta.dirname, "fixtures", "supervisor-extension-unrelated.ts");

interface ProviderReport {
	pid: number;
	provider: string;
	modelId: string;
	cwd: string;
	resident: boolean;
	oneOff: boolean;
	captured: boolean;
	tools: string[];
	unrelatedPromptMarker: boolean;
}

let tempDir: string;
let agentDir: string;
let kbDir: string;
let reportPath: string;

function readReports(): ProviderReport[] {
	return readFileSync(reportPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as ProviderReport);
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-supervisor-extension-provider-"));
	agentDir = join(tempDir, "agent");
	kbDir = join(tempDir, "kb");
	for (const dir of [agentDir, kbDir]) mkdirSync(dir);
	reportPath = join(tempDir, "requests.jsonl");
	// No auth.json or models.json: only a configured extension defines bridge-faux.
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			extensions: [UNRELATED_EXTENSION_PATH, EXTENSION_PATH],
			supervisorModel: "bridge-faux/haiku",
		}),
	);
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

it("instruction review uses a supervisorModel provider registered by an installed extension as a one-off call", async () => {
	vi.stubEnv("PI_SUPERVISOR_EXTENSION_REPORT", reportPath);
	try {
		const modelRegistry = createSupervisorModelRegistry(agentDir);
		await createSupervisorResourceLoader(agentDir, kbDir, createSupervisorSettingsManager(), modelRegistry);
		const evaluate = createSupervisorInstructionEvaluator(modelRegistry, agentDir, kbDir);

		expect(await evaluate("Continue the goal", new AbortController().signal)).toBe("ACCEPT");
		expect(readReports()).toEqual([
			{
				pid: process.pid,
				provider: "bridge-faux",
				modelId: "haiku",
				cwd: kbDir,
				resident: false,
				oneOff: true,
				captured: true,
				tools: [],
				unrelatedPromptMarker: false,
			},
		]);
	} finally {
		vi.unstubAllEnvs();
	}
});

it("resident Supervisor answers through an extension-registered supervisorModel provider with only that extension's hooks", async () => {
	const stateDir = join(tempDir, "state");
	const homeDir = join(tempDir, "home");
	for (const dir of [stateDir, homeDir]) mkdirSync(dir);
	const controlDbPath = getControlDbPath(stateDir);
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", join(import.meta.dirname, "fixtures", "supervisor-extension-resident.ts")],
		{
			cwd: kbDir,
			env: {
				PATH: process.env.PATH,
				HOME: homeDir,
				XDG_CONFIG_HOME: join(homeDir, "config"),
				XDG_CACHE_HOME: join(homeDir, "cache"),
				[ENV_AGENT_DIR]: agentDir,
				[ENV_STATE_DIR]: stateDir,
				PI_KB_DIR: kbDir,
				PI_OFFLINE: "1",
				PI_SUPERVISOR_EXTENSION_REPORT: reportPath,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		output += String(chunk);
	});
	const exited = once(child, "exit");
	try {
		await vi.waitFor(
			async () => {
				const snapshot = await probeResidentConsole({
					socketPath: `${controlDbPath}.supervisor-console.sock`,
					service: "supervisor",
				});
				expect(snapshot.identity?.pid).toBe(child.pid);
			},
			{ timeout: 15_000, interval: 20 },
		);
		const id = postSupervisorRequest(controlDbPath, {
			deadlineAt: new Date(Date.now() + 15_000).toISOString(),
			kind: "goal_set_review",
			payload: { proposedObjective: "Extension provider marker", userMessages: ["Extension provider marker"] },
			projectId: "pi",
			senderSessionId: "extension-provider-regression",
		});
		notifySupervisorRequest(controlDbPath);
		await vi.waitFor(() => expect(readSupervisorRequest(controlDbPath, id)?.status).toBe("completed"), {
			timeout: 15_000,
			interval: 20,
		});

		expect(readSupervisorRequest(controlDbPath, id)?.response).toMatchObject({
			kind: "set",
			objective: "Reviewed by the extension provider",
		});
		expect(readReports()).toEqual([
			{
				pid: child.pid,
				provider: "bridge-faux",
				modelId: "haiku",
				cwd: kbDir,
				resident: true,
				oneOff: false,
				captured: true,
				tools: ["edit", "end_turn", "read", "supervisor_response", "write"],
				unrelatedPromptMarker: false,
			},
		]);
	} finally {
		if (output) console.log(`Supervisor output:\n${output}`);
		child.kill("SIGTERM");
		const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
		try {
			await exited;
		} finally {
			clearTimeout(killTimer);
		}
	}
}, 30_000);
