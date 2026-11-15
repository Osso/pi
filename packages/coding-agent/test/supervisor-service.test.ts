import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cancelSupervisorRequest,
	claimNextSupervisorRequest,
	getControlDbPath,
	postSupervisorRequest,
	readSupervisorRequest,
} from "../src/core/session-control-db.ts";
import { blockSupervisorFileAccess } from "../src/supervisor/request-evaluation.ts";
import {
	buildSupervisorPrompt,
	parseSupervisorResponse,
	runSupervisorRequest,
	SUPERVISOR_REQUEST_POLICY,
} from "../src/supervisor/service.ts";

describe("Supervisor request service", () => {
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
			replyTo: { sessionId: "goal-session", agentId: null, requestId: "escape" },
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
		expect(
			cancelSupervisorRequest(
				controlDbPath,
				{ sessionId: "goal-session", agentId: null, requestId: "escape" },
				"Supervisor request cancelled",
			),
		).toBe(true);
		releaseEvaluation();

		expect(await run).toBe("cancelled");
		expect(evaluationSignal?.aborted).toBe(true);
		expect(readSupervisorRequest(controlDbPath, requestId)).toMatchObject({ status: "cancelled" });
	});

	it("limits file access to Supervisor KB memory", () => {
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

	it("keeps the standing goal policy in the session policy, not in each request", () => {
		const policy = SUPERVISOR_REQUEST_POLICY;
		for (const rule of [
			"Requirements are binding only when they come from explicit user instructions or persistent project contracts",
			"Assistant-authored plans, summaries, task IDs, issue IDs, and prior review instructions are evidence or context only",
			"preserve every grounded requirement, exclusion, and completion criterion, but remove unsupported additions",
			"Only an explicit user instruction may reset or narrow the grounded parent objective",
			"Return complete only when evidence proves every requirement and completion criterion of the full parent objective",
			"A child-slice completion that lacks that proof must return continue with the smallest corrective instruction",
			'instructions exactly "Continue working toward the active goal."',
			"Do not use wait while other authorized goal work can proceed without that result; use continue",
			"Use pause only when progress requires user action",
			"Escalate when any question involves new scope, cost, safety risk, an irreversible action, or a product tradeoff",
			"calling supervisor_response exactly once as the final action",
		]) {
			expect(policy).toContain(rule);
		}
		const prompt = buildSupervisorPrompt({
			claimToken: "runtime",
			claimedAt: "2026-07-17T12:00:00.000Z",
			createdAt: "2026-07-17T12:00:00.000Z",
			deadlineAt: "2026-07-17T12:03:00.000Z",
			id: 2,
			kind: "goal_idle_review",
			payload: { objective: "Fix every unresolved Sentry issue" },
			projectId: "pi",
			senderSessionId: "main",
			status: "claimed",
		});
		expect(prompt).toContain("Respond with kind complete, pause, wait, continue (with instructions), or error");
		expect(prompt).toContain('"objective": "Fix every unresolved Sentry issue"');
		expect(prompt).not.toContain("Requirements are binding");
		expect(prompt.length).toBeLessThan(600);
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
		expect(buildSupervisorPrompt(request)).toContain("Respond with kind advisory and a non-empty answer");
		expect(SUPERVISOR_REQUEST_POLICY).toContain("advice only");
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
