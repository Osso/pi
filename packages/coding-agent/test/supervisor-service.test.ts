import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cancelSupervisorRequest,
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

const supervisorMain = fileURLToPath(new URL("../src/supervisor/main.ts", import.meta.url));

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

	it("aborts an active evaluation after caller cancellation without writing a response", async () => {
		const requestId = postSupervisorRequest(controlDbPath, {
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
			kind: "goal_idle_review",
			payload: { objective: "keep active" },
			projectId: "pi",
			senderSessionId: "goal-session",
		});
		const request = claimNextSupervisorRequest(controlDbPath, "runtime");
		if (!request) throw new Error("expected claimed request");
		let evaluationSignal: AbortSignal | undefined;
		let releaseEvaluation!: () => void;
		const evaluationFinished = new Promise<void>((resolve) => {
			releaseEvaluation = resolve;
		});

		const run = runSupervisorRequest({
			controlDbPath,
			evaluate: async (_prompt, signal) => {
				evaluationSignal = signal;
				await evaluationFinished;
				throw new Error("evaluation aborted");
			},
			pollIntervalMs: 1,
			request,
		});

		await vi.waitFor(() => expect(evaluationSignal).toBeDefined());
		expect(cancelSupervisorRequest(controlDbPath, requestId, "goal-session", "Supervisor request cancelled")).toBe(
			true,
		);
		releaseEvaluation();

		expect(await run).toBe("cancelled");
		expect(evaluationSignal?.aborted).toBe(true);
		expect(readSupervisorRequest(controlDbPath, requestId)).toMatchObject({ status: "cancelled" });
	});

	it("uses the fixed local Sol model with low effort and no web tool", () => {
		const source = readFileSync(supervisorMain, "utf8");

		expect(source).toContain('modelRegistry.find("openai-codex", "gpt-5.6-sol")');
		expect(source).toContain('thinkingLevel: "low"');
		expect(source).not.toContain('"web_search"');
	});

	it("loads only the Supervisor mutation gate extension", async () => {
		const settingsManager = createSupervisorSettingsManager();
		const resourceLoader = await createSupervisorResourceLoader(tempDir, tempDir, settingsManager);

		const extensions = resourceLoader.getExtensions().extensions;
		expect(extensions).toHaveLength(1);
		expect(extensions.some((extension) => extension.handlers.has("compaction"))).toBe(false);
		expect(extensions[0]?.toolGates.length).toBeGreaterThan(0);
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
		expect(
			parseSupervisorResponse(
				"goal_set_review",
				'{"kind":"set","objective":"keep broad scope; add subtask","reason":"additive"}',
			),
		).toEqual({ kind: "set", objective: "keep broad scope; add subtask", reason: "additive" });
		expect(parseSupervisorResponse("goal_set_review", '{"kind":"continue","reason":"wrong kind"}')).toBeUndefined();
		expect(parseSupervisorResponse("approval_review", '{"kind":"complete","reason":"done"}')).toBeUndefined();
		expect(parseSupervisorResponse("approval_review", '{"kind":"pause","reason":"wait"}')).toBeUndefined();
	});

	it("rejects valid JSON followed by generated text", () => {
		expect(
			parseSupervisorResponse(
				"goal_completion_review",
				'{"kind":"complete","reason":"verified"}  ... Need end_turn.',
			),
		).toBeUndefined();
	});

	it("tells goal set reviewers to preserve current scope and add the proposal", () => {
		const prompt = buildSupervisorPrompt({
			claimToken: "runtime",
			claimedAt: "2026-08-01T12:00:00.000Z",
			createdAt: "2026-08-01T12:00:00.000Z",
			deadlineAt: "2026-08-01T12:01:00.000Z",
			id: 3,
			kind: "goal_set_review",
			payload: { currentObjective: "ship the feature", proposedObjective: "write one test" },
			projectId: "pi",
			senderSessionId: "main",
			status: "claimed",
		});

		expect(prompt).toContain("Use kind set with a non-empty reason and objective");
		expect(prompt).toContain(
			"Treat currentObjective and proposedObjective as current claims, not automatically as the full scope",
		);
		expect(prompt).toContain(
			"Preserve currentObjective and any known unfinished parent objective from shared Supervisor context or KB memory",
		);
		expect(prompt).toContain("Only an explicit user instruction may reset or narrow that parent");
		expect(prompt).not.toContain("Only an explicit user instruction may reset, narrow, or complete that parent");
		expect(prompt).not.toContain("complete that parent");
		expect(prompt).toContain(
			"When currentObjective and any known unfinished parent are both absent, return proposedObjective unchanged",
		);
	});

	it("frames goal reviews as exception-based peer unblocking", () => {
		const prompt = buildSupervisorPrompt({
			claimToken: "runtime",
			claimedAt: "2026-07-17T12:00:00.000Z",
			createdAt: "2026-07-17T12:00:00.000Z",
			deadlineAt: "2026-07-17T12:03:00.000Z",
			id: 2,
			kind: "goal_idle_review",
			payload: { objective: "Fix every unresolved Sentry issue", terminalTurn: [] },
			projectId: "pi",
			senderSessionId: "main",
			status: "claimed",
		});

		expect(prompt).toContain("resident peer unblocker and policy engine");
		expect(prompt).toContain(
			"Evaluate this bounded request against the cumulative objective from shared Supervisor context and KB memory; avoid routine task management.",
		);
		expect(prompt).not.toContain("Evaluate only this bounded request");
		expect(prompt).toContain(
			"Primary responsibility: maintain cumulative big-picture consistency across requests, not routine task decomposition",
		);
		expect(prompt).toContain(
			"Treat payload.objective and any current claims as claims about the active goal, not automatically as the full scope",
		);
		expect(prompt).toContain(
			"Preserve any known unfinished parent objective from shared Supervisor context or KB memory",
		);
		expect(prompt).toContain("Only an explicit user instruction may reset or narrow that parent");
		expect(prompt).toContain(
			"Return complete only when evidence proves every requirement and completion criterion of the full parent objective",
		);
		expect(prompt).toContain(
			"A child-slice completion that lacks that proof must return continue with the smallest corrective instruction",
		);
		expect(prompt).toContain("narrowed or lost goals");
		expect(prompt).toContain("dropped requirements, exclusions, or completion criteria");
		expect(prompt).toContain("contradictions between claims and evidence");
		expect(prompt).toContain("repeated or circular work");
		expect(prompt).toContain("missing completion proof");
		expect(prompt).toContain('instructions exactly "Continue working toward the active goal."');
		expect(prompt).toContain("Use different continue instructions only when evidence identifies a concrete omission");
		expect(prompt).toContain(
			"Do not prescribe routine decomposition, sequencing, implementation details, or oversight",
		);
		expect(prompt).toContain("Use wait when progress is already underway asynchronously");
		expect(prompt).toContain("or depends on an external condition that can be rechecked");
		expect(prompt).toContain("Use pause only when progress requires user action");
		expect(prompt).toContain("Call supervisor_response exactly once as the final action");
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
		).toContain('instructions exactly "Continue working toward the active goal."');
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
		).toContain("Use kind complete, pause, wait, continue, or error");
	});

	it("prompts for and parses advisory-only responses", () => {
		const request = {
			claimToken: "runtime",
			claimedAt: "2026-07-28T23:00:00.000Z",
			createdAt: "2026-07-28T23:00:00.000Z",
			deadlineAt: "2026-07-28T23:03:00.000Z",
			id: 4,
			kind: "supervisor_advisory" as never,
			payload: { context: "Only the scoped diff", question: "Is anything missing?" },
			projectId: "pi",
			senderSessionId: "main",
			status: "claimed" as const,
		};
		const prompt = buildSupervisorPrompt(request);
		expect(prompt).toContain("Use kind advisory with a non-empty answer");
		expect(prompt).toContain("advisory only");
		expect(parseSupervisorResponse(request.kind, { kind: "advisory", answer: "Nothing is missing." })).toEqual({
			kind: "advisory",
			answer: "Nothing is missing.",
		});
		expect(
			parseSupervisorResponse(request.kind, {
				kind: "continue",
				reason: "not advisory",
				instructions: "Do work",
			}),
		).toBeUndefined();
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

	it("accepts a structured supervisor response tool call without assistant JSON text", async () => {
		const requestId = postSupervisorRequest(controlDbPath, {
			deadlineAt: new Date(Date.now() + 30_000).toISOString(),
			kind: "goal_completion_review",
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
				sessionManager.appendMessage(
					fauxAssistantMessage(
						fauxToolCall("supervisor_response", { kind: "complete", reason: "structured proof" }),
						{ stopReason: "toolUse" },
					),
				);
			},
			sessionManager,
		};

		await processSupervisorRequest(controlDbPath, request, session);

		expect(readSupervisorRequest(controlDbPath, requestId)).toMatchObject({
			response: { kind: "complete", reason: "structured proof" },
			status: "completed",
		});
	});

	it("uses the last completed JSON response when the duplicate guard ends with end_turn", async () => {
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
				sessionManager.appendMessage(fauxAssistantMessage('{"kind":"complete","reason":"guarded response"}'));
				sessionManager.appendMessage(
					fauxAssistantMessage(fauxToolCall("end_turn", { reason: "duplicate response detected" }), {
						stopReason: "toolUse",
					}),
				);
			},
			sessionManager,
		};

		await processSupervisorRequest(controlDbPath, request, session);

		expect(readSupervisorRequest(controlDbPath, requestId)).toMatchObject({
			response: { kind: "complete", reason: "guarded response" },
			status: "completed",
		});
	});

	it.each(["error", "aborted", "length"] as const)(
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
