import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	claimNextSupervisorRequest,
	getControlDbPath,
	postSupervisorRequest,
	readSupervisorRequest,
} from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	blockSupervisorFileAccess,
	createSupervisorResourceLoader,
	createSupervisorSettingsManager,
	processSupervisorRequest,
	SUPERVISOR_EXCLUDED_TOOL_NAMES,
	SUPERVISOR_TOOL_NAMES,
	validateSupervisorExtensionLoad,
} from "../src/supervisor/main.ts";
import { buildSupervisorPrompt, parseSupervisorResponse, runSupervisorRequest } from "../src/supervisor/service.ts";

const deployScript = fileURLToPath(new URL("../../../deploy.sh", import.meta.url));
const serviceUnit = fileURLToPath(new URL("../systemd/pi-supervisor.service", import.meta.url));
const supervisorMain = fileURLToPath(new URL("../src/supervisor/main.ts", import.meta.url));
const preserveProviderContext = () => undefined;

describe("resident Supervisor service", () => {
	let tempDir: string;
	let controlDbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-supervisor-service-"));
		controlDbPath = getControlDbPath(tempDir);
	});

	afterEach(() => {
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("uses the fixed local Sol model with low effort and no web tool", () => {
		const source = readFileSync(supervisorMain, "utf8");

		expect(source).toContain('modelRegistry.find("openai-codex", "gpt-5.6-sol")');
		expect(source).toContain('thinkingLevel: "low"');
		expect(source).not.toContain('"web_search"');
	});

	it("loads only the explicit Supervisor extension allowlist", async () => {
		const settingsManager = createSupervisorSettingsManager();
		const resourceLoader = await createSupervisorResourceLoader(tempDir, tempDir, settingsManager);

		const extensions = resourceLoader.getExtensions().extensions;
		expect(extensions).toHaveLength(2);
		expect(extensions.some((extension) => extension.handlers.has("compaction"))).toBe(true);
		expect(extensions.some((extension) => extension.toolGates.length > 0)).toBe(true);
	});

	it("rejects extension diagnostics before the Supervisor session starts", () => {
		expect(() =>
			validateSupervisorExtensionLoad({
				errors: [{ path: "<openai-remote-compact>", error: "factory failed" }],
				extensions: [],
				runtime: {} as never,
			}),
		).toThrow("Supervisor extension load failed: <openai-remote-compact>: factory failed");
	});

	it("limits file access to Supervisor KB memory", () => {
		const settings = createSupervisorSettingsManager();
		expect(settings.getExplicitSandboxProfile()).toBe("full-access");
		expect(settings.getApprovalPolicy()).toBe("auto-approve");
		expect(SUPERVISOR_TOOL_NAMES).toEqual(["read", "edit", "write"]);
		expect(SUPERVISOR_EXCLUDED_TOOL_NAMES).toEqual(expect.arrayContaining(["bash", "pyrun_eval", "spawn_agent"]));
		expect(
			blockSupervisorFileAccess("/syncthing/Sync/KB", {
				input: { path: "/worktree/source.ts" },
				toolName: "read",
			}),
		).toMatchObject({ block: true });
		expect(
			blockSupervisorFileAccess("/syncthing/Sync/KB", {
				input: { path: "/syncthing/Sync/KB/memory/supervisor/pi.md" },
				toolName: "read",
			}),
		).toBeUndefined();
		expect(
			blockSupervisorFileAccess("/syncthing/Sync/KB", { input: { path: "/worktree/source.ts" }, toolName: "write" }),
		).toMatchObject({ block: true });
	});

	it("blocks normalized and symlinked paths that escape the KB", () => {
		const kbDir = join(tempDir, "kb");
		const outsideDir = join(tempDir, "outside");
		mkdirSync(kbDir);
		mkdirSync(outsideDir);
		writeFileSync(join(outsideDir, "outside.txt"), "outside");
		symlinkSync(outsideDir, join(kbDir, "escape"));
		symlinkSync(outsideDir, join(kbDir, "escape dir"));
		symlinkSync(join(outsideDir, "outside.txt"), join(kbDir, "capture’.txt"));

		const sharedEscapePaths = [
			"file:///etc/passwd",
			"file://%",
			"@/etc/passwd",
			"~/outside.txt",
			join(kbDir, "escape", "new.txt"),
			join(kbDir, "escape dir", "new.txt"),
		];
		for (const path of sharedEscapePaths) {
			expect(blockSupervisorFileAccess(kbDir, { input: { path }, toolName: "read" })).toMatchObject({ block: true });
			expect(blockSupervisorFileAccess(kbDir, { input: { path }, toolName: "write" })).toMatchObject({
				block: true,
			});
		}
		expect(
			blockSupervisorFileAccess(kbDir, { input: { path: join(kbDir, "capture'.txt") }, toolName: "read" }),
		).toMatchObject({ block: true });
	});

	it("deploys the installed Bun binary as a resident systemd service", () => {
		const deploy = readFileSync(deployScript, "utf8");
		const unit = readFileSync(serviceUnit, "utf8");

		expect(unit).toContain("ExecStart=@PI_SUPERVISOR_BINARY@ supervisor");
		expect(deploy).toContain("@PI_SUPERVISOR_BINARY@");
		expect(deploy).not.toContain("@PI_NODE_LAUNCHER@");
		expect(deploy).not.toContain("@PI_TSCONFIG@");
		expect(deploy).not.toContain("@PI_CLI_SOURCE@");
		expect(deploy).toContain("pi-supervisor.service");
		expect(deploy).toContain("systemctl --user enable --now pi-supervisor.service");
		expect(deploy).toContain("systemctl --user restart pi-supervisor.service");
		expect(deploy).toContain("systemctl --user is-active --quiet pi-supervisor.service");
	});

	it("accepts only response kinds valid for the request", () => {
		expect(parseSupervisorResponse("approval_review", '{"kind":"approve","reason":"bounded"}')).toEqual({
			kind: "approve",
			reason: "bounded",
		});
		expect(
			parseSupervisorResponse(
				"goal_idle_review",
				'{"kind":"continue","reason":"tests missing","instructions":"Run targeted tests."}',
			),
		).toEqual({ kind: "continue", reason: "tests missing", instructions: "Run targeted tests." });
		expect(parseSupervisorResponse("goal_idle_review", '{"kind":"pause","reason":"waiting for user input"}')).toEqual(
			{
				kind: "pause",
				reason: "waiting for user input",
			},
		);
		expect(parseSupervisorResponse("goal_idle_review", '{"kind":"wait","reason":"reviewer is running"}')).toEqual({
			kind: "wait",
			reason: "reviewer is running",
		});
		expect(parseSupervisorResponse("approval_review", '{"kind":"complete","reason":"done"}')).toBeUndefined();
		expect(parseSupervisorResponse("approval_review", '{"kind":"pause","reason":"wait"}')).toBeUndefined();
	});

	it("tells goal reviewers to keep goals active while asynchronous work is already running", () => {
		const prompt = buildSupervisorPrompt({
			claimToken: "runtime",
			claimedAt: "2026-07-17T12:00:00.000Z",
			createdAt: "2026-07-17T12:00:00.000Z",
			deadlineAt: "2026-07-17T12:03:00.000Z",
			id: 2,
			kind: "goal_idle_review",
			payload: { objective: "finish", terminalTurn: [] },
			projectId: "pi",
			senderSessionId: "main",
			status: "claimed",
		});

		expect(prompt).toContain('{"kind":"wait","reason":"..."}');
		expect(prompt).toContain("Return wait when progress is already underway asynchronously");
	});

	it("builds a bounded prompt without historical transcript retrieval", () => {
		const prompt = buildSupervisorPrompt({
			claimToken: "runtime",
			claimedAt: "2026-07-14T12:00:00.000Z",
			createdAt: "2026-07-14T12:00:00.000Z",
			deadlineAt: "2026-07-14T12:00:30.000Z",
			id: 1,
			kind: "approval_review",
			payload: { toolName: "read" },
			projectId: "pi",
			senderSessionId: "main",
			status: "claimed",
		});

		expect(prompt).toContain("memory/supervisor/pi.md");
		expect(prompt).toContain('"toolName": "read"');
		expect(prompt).toContain("Do not request or reconstruct historical session transcripts");
		expect(
			buildSupervisorPrompt({
				claimToken: "runtime",
				claimedAt: "2026-07-17T12:00:00.000Z",
				createdAt: "2026-07-17T12:00:00.000Z",
				deadlineAt: "2026-07-17T12:03:00.000Z",
				id: 2,
				kind: "goal_idle_review",
				payload: { objective: "finish" },
				projectId: "pi",
				senderSessionId: "main",
				status: "claimed",
			}),
		).toContain("concrete, actionable next step");
		expect(
			buildSupervisorPrompt({
				claimToken: "runtime",
				claimedAt: "2026-07-17T12:00:00.000Z",
				createdAt: "2026-07-17T12:00:00.000Z",
				deadlineAt: "2026-07-17T12:03:00.000Z",
				id: 3,
				kind: "goal_idle_review",
				payload: { objective: "finish" },
				projectId: "pi",
				senderSessionId: "main",
				status: "claimed",
			}),
		).toContain('"kind":"pause"');
	});

	it("does not reuse a prior assistant response when the current request produces none", async () => {
		postSupervisorRequest(controlDbPath, {
			deadlineAt: new Date(Date.now() + 30_000).toISOString(),
			kind: "approval_review",
			payload: { toolName: "read" },
			projectId: "pi",
			senderSessionId: "main",
		});
		const approvalRequest = claimNextSupervisorRequest(controlDbPath, "runtime");
		if (!approvalRequest) throw new Error("expected approval request");
		let promptCount = 0;
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const session = {
			abort: async () => {},
			prompt: async () => {
				promptCount += 1;
				if (promptCount !== 1) return;
				sessionManager.appendMessage(fauxAssistantMessage('{"kind":"approve","reason":"prior approval"}'));
			},
			sessionManager,
		};
		await processSupervisorRequest(controlDbPath, approvalRequest, session);

		const goalRequestId = postSupervisorRequest(controlDbPath, {
			deadlineAt: new Date(Date.now() + 30_000).toISOString(),
			kind: "goal_idle_review",
			payload: { objective: "finish" },
			projectId: "pi",
			senderSessionId: "main",
		});
		const goalRequest = claimNextSupervisorRequest(controlDbPath, "runtime");
		if (!goalRequest) throw new Error("expected goal request");
		await processSupervisorRequest(controlDbPath, goalRequest, session);

		expect(readSupervisorRequest(controlDbPath, goalRequestId)).toMatchObject({
			response: { kind: "error", reason: "Supervisor model returned no assistant text for current request" },
			status: "completed",
		});
	});

	it("extracts the current response after compaction replaces the message array", async () => {
		const requestId = postSupervisorRequest(controlDbPath, {
			deadlineAt: new Date(Date.now() + 30_000).toISOString(),
			kind: "goal_idle_review",
			payload: { objective: "finish" },
			projectId: "pi",
			senderSessionId: "main",
		});
		const request = claimNextSupervisorRequest(controlDbPath, "runtime");
		if (!request) throw new Error("expected request");
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const firstEntryId = sessionManager.appendMessage({ role: "user", content: "old user", timestamp: 1 });
		sessionManager.appendMessage(fauxAssistantMessage("old assistant"));
		const session = {
			abort: async () => {},
			prompt: async () => {
				sessionManager.appendCompaction("compacted history", firstEntryId, 100);
				sessionManager.appendMessage(fauxAssistantMessage('{"kind":"complete","reason":"current response"}'));
			},
			sessionManager,
		};

		await processSupervisorRequest(controlDbPath, request, session);

		expect(readSupervisorRequest(controlDbPath, requestId)).toMatchObject({
			response: { kind: "complete", reason: "current response" },
			status: "completed",
		});
	});

	it.each(["error", "aborted", "length", "toolUse"] as const)(
		"rejects valid partial JSON when the terminal assistant stops with %s",
		async (stopReason) => {
			const requestId = postSupervisorRequest(controlDbPath, {
				deadlineAt: new Date(Date.now() + 30_000).toISOString(),
				kind: "goal_idle_review",
				payload: { objective: "finish" },
				projectId: "pi",
				senderSessionId: "main",
			});
			const request = claimNextSupervisorRequest(controlDbPath, "runtime");
			if (!request) throw new Error("expected request");
			const sessionManager = SessionManager.create(tempDir, tempDir);
			const session = {
				abort: async () => {},
				prompt: async () => {
					sessionManager.appendMessage(fauxAssistantMessage('{"kind":"complete","reason":"intermediate"}'));
					sessionManager.appendMessage(
						fauxAssistantMessage('{"kind":"complete","reason":"partial terminal response"}', { stopReason }),
					);
				},
				sessionManager,
			};

			await processSupervisorRequest(controlDbPath, request, session);

			expect(readSupervisorRequest(controlDbPath, requestId)).toMatchObject({
				response: { kind: "error", reason: `Supervisor model request ended with ${stopReason}` },
				status: "completed",
			});
		},
	);

	it("persists the parsed model decision", async () => {
		const requestId = postSupervisorRequest(controlDbPath, {
			deadlineAt: new Date(Date.now() + 30_000).toISOString(),
			kind: "approval_review",
			payload: { toolName: "read" },
			projectId: "pi",
			senderSessionId: "main",
		});
		const request = claimNextSupervisorRequest(controlDbPath, "runtime");
		if (!request) throw new Error("expected request");

		await runSupervisorRequest({
			controlDbPath,
			evaluate: vi.fn(async () => '{"kind":"approve","reason":"bounded"}'),
			request,
		});

		expect(readSupervisorRequest(controlDbPath, requestId)).toMatchObject({
			response: { kind: "approve", reason: "bounded" },
			status: "completed",
		});
	});

	it("aborts evaluation and persists error when the request deadline expires", async () => {
		const requestId = postSupervisorRequest(controlDbPath, {
			deadlineAt: new Date(Date.now() + 5).toISOString(),
			kind: "approval_review",
			payload: { toolName: "read" },
			projectId: "pi",
			senderSessionId: "main",
		});
		const request = claimNextSupervisorRequest(controlDbPath, "runtime");
		if (!request) throw new Error("expected request");

		await runSupervisorRequest({
			controlDbPath,
			evaluate: async (_prompt, signal) => {
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				return "aborted";
			},
			pollIntervalMs: 1,
			request,
		});

		expect(readSupervisorRequest(controlDbPath, requestId)).toMatchObject({
			response: { kind: "error", reason: "Supervisor request deadline expired" },
			status: "completed",
		});
	});

	it("aborts and requeues a goal review when an approval arrives", async () => {
		const goalId = postSupervisorRequest(controlDbPath, {
			deadlineAt: new Date(Date.now() + 120_000).toISOString(),
			kind: "goal_idle_review",
			payload: { objective: "finish" },
			projectId: "pi",
			senderSessionId: "main",
		});
		const request = claimNextSupervisorRequest(controlDbPath, "runtime");
		if (!request) throw new Error("expected request");
		let releaseEvaluation: (() => void) | undefined;
		const evaluationStarted = new Promise<void>((resolve) => {
			releaseEvaluation = resolve;
		});
		const run = runSupervisorRequest({
			controlDbPath,
			evaluate: vi.fn(async (_prompt, signal) => {
				releaseEvaluation?.();
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				return '{"kind":"continue","reason":"interrupted","instructions":"retry"}';
			}),
			pollIntervalMs: 1,
			request,
		});
		await evaluationStarted;
		postSupervisorRequest(controlDbPath, {
			deadlineAt: new Date(Date.now() + 30_000).toISOString(),
			kind: "approval_review",
			payload: { toolName: "write" },
			projectId: "pi",
			senderSessionId: "other",
		});

		await expect(run).resolves.toBe("preempted");
		expect(readSupervisorRequest(controlDbPath, goalId)).toMatchObject({ status: "pending" });
		expect(claimNextSupervisorRequest(controlDbPath, "runtime-2")).toMatchObject({ kind: "approval_review" });
	});
});
