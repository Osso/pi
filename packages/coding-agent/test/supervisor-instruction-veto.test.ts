import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	claimNextSupervisorRequest,
	getControlDbPath,
	postSupervisorRequest,
	readSupervisorRequest,
	type SupervisorRequest,
	type SupervisorRequestKind,
} from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	createSupervisorInstructionReviewer,
	GENERIC_GOAL_CONTINUATION,
	processSupervisorRequest,
	type SupervisorInstructionReviewer,
} from "../src/supervisor/main.ts";
import {
	buildSupervisorInstructionReviewContext,
	parseSupervisorInstructionReviewDecision,
	supervisorInstructionRejectionFeedback,
} from "../src/supervisor/service.ts";

const REJECTED_INSTRUCTION = "Implement the parser tests next.";
const ACCEPTED_INSTRUCTION = "The current evidence shows an unresolved completion gap.";

type SupervisorSessionForTest = Parameters<typeof processSupervisorRequest>[2];

interface ClaimedRequest {
	id: number;
	request: SupervisorRequest;
}

interface FakeResidentSession {
	promptCount: () => number;
	sendCustomMessage: ReturnType<typeof vi.fn>;
	session: SupervisorSessionForTest;
	sessionManager: SessionManager;
}

function createFakeResidentSession(tempDir: string, responses: unknown[]): FakeResidentSession {
	const sessionManager = SessionManager.create(tempDir, tempDir);
	const sendCustomMessage = vi.fn(async () => {});
	let promptCount = 0;
	const session = {
		abort: async () => {},
		prompt: async () => {
			const response = responses[promptCount];
			promptCount += 1;
			if (response === undefined) return;
			const text = typeof response === "string" ? response : JSON.stringify(response);
			sessionManager.appendMessage(fauxAssistantMessage(text));
		},
		sendCustomMessage,
		sessionManager,
	};
	return { promptCount: () => promptCount, sendCustomMessage, session, sessionManager };
}

describe("Supervisor instruction veto contract", () => {
	it.each([
		["ACCEPT", "accept"],
		["REJECT_TASK_ASSIGNMENT", "reject_task_assignment"],
		["REJECT_IMPLEMENTATION_PRESCRIPTION", "reject_implementation_prescription"],
		["REJECT_SEQUENCING_INSTRUCTION", "reject_sequencing_instruction"],
		["REJECT_AGENT_OR_TOOL_DIRECTION", "reject_agent_or_tool_direction"],
		["REJECT_PLAN_OVERRIDE", "reject_plan_override"],
	] as const)("parses the exact closed decision token %s", (rawResponse, expected) => {
		expect(parseSupervisorInstructionReviewDecision(rawResponse)).toBe(expected);
	});

	it.each([
		[
			"reject_task_assignment",
			"Policy rejection: task_assignment. Automatic goal reviews must not assign a tactical task.",
		],
		[
			"reject_implementation_prescription",
			"Policy rejection: implementation_prescription. Automatic goal reviews must not prescribe implementation details.",
		],
		[
			"reject_sequencing_instruction",
			"Policy rejection: sequencing_instruction. Automatic goal reviews must not choose work order or next steps.",
		],
		[
			"reject_agent_or_tool_direction",
			"Policy rejection: agent_or_tool_direction. Automatic goal reviews must not direct agents, tools, commands, or files.",
		],
		[
			"reject_plan_override",
			"Policy rejection: plan_override. Automatic goal reviews must not replace or redirect the main agent's plan.",
		],
	] as const)("maps %s to fixed resident feedback", (reason, expected) => {
		expect(supervisorInstructionRejectionFeedback(reason)).toBe(expected);
	});

	it.each(["", " ACCEPT", "ACCEPT\n", "accept", "REJECT_TASK_ASSIGNMENT now", '{"decision":"ACCEPT"}', "UNKNOWN"])(
		"rejects non-exact decision output: %j",
		(rawResponse) => {
			expect(parseSupervisorInstructionReviewDecision(rawResponse)).toBeUndefined();
		},
	);

	it("builds one tool-free context from fixed policy and the raw current message", () => {
		const instructions = "Current instruction marker: preserve the broad objective.";
		const context = buildSupervisorInstructionReviewContext(instructions, 123);

		expect(context.messages).toEqual([{ role: "user", content: instructions, timestamp: 123 }]);
		expect(context.tools).toBeUndefined();
		expect(context.systemPrompt).toContain("ACCEPT");
		expect(context.systemPrompt).toContain("REJECT_TASK_ASSIGNMENT");
		expect(context.systemPrompt).toContain("REJECT_IMPLEMENTATION_PRESCRIPTION");
		expect(context.systemPrompt).toContain("REJECT_SEQUENCING_INSTRUCTION");
		expect(context.systemPrompt).toContain("REJECT_AGENT_OR_TOOL_DIRECTION");
		expect(context.systemPrompt).toContain("REJECT_PLAN_OVERRIDE");
		expect(context.systemPrompt).not.toContain(instructions);
		for (const forbiddenField of [
			"goal",
			"projectId",
			"evidence",
			"transcript",
			"workspace",
			"memory",
			"priorDecision",
		]) {
			expect(context.systemPrompt).not.toContain(`"${forbiddenField}"`);
		}
	});

	it("evaluates each raw instruction independently and parses only that response", async () => {
		const responses = ["ACCEPT", "REJECT_TASK_ASSIGNMENT"];
		const evaluate = vi.fn(async () => responses.shift());
		const reviewInstructions = createSupervisorInstructionReviewer(evaluate);
		const firstInstructions = "First instruction marker: inspect the remaining proof.";
		const secondInstructions = "Second instruction marker: preserve the active objective.";
		const firstSignal = new AbortController().signal;
		const secondSignal = new AbortController().signal;

		await expect(reviewInstructions(firstInstructions, firstSignal)).resolves.toBe("accept");
		await expect(reviewInstructions(secondInstructions, secondSignal)).resolves.toBe("reject_task_assignment");

		expect(evaluate).toHaveBeenNthCalledWith(1, firstInstructions, firstSignal);
		expect(evaluate).toHaveBeenNthCalledWith(2, secondInstructions, secondSignal);
	});

	it("does not evaluate a pre-aborted review", async () => {
		const evaluate = vi.fn(async () => "ACCEPT");
		const reviewInstructions = createSupervisorInstructionReviewer(evaluate);
		const controller = new AbortController();
		controller.abort();

		expect(await reviewInstructions("aborted instruction", controller.signal)).toBeUndefined();
		expect(evaluate).not.toHaveBeenCalled();
	});
});

describe("Supervisor instruction veto delivery", () => {
	let tempDir: string;
	let controlDbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-supervisor-instruction-veto-"));
		controlDbPath = getControlDbPath(tempDir);
	});

	afterEach(() => {
		rmSync(tempDir, { force: true, recursive: true });
	});

	function postAndClaim(kind: SupervisorRequestKind, payload: Record<string, unknown>): ClaimedRequest {
		const id = postSupervisorRequest(controlDbPath, {
			deadlineAt: new Date(Date.now() + 30_000).toISOString(),
			kind,
			payload,
			projectId: "pi",
			senderSessionId: "main",
		});
		const request = claimNextSupervisorRequest(controlDbPath, "runtime");
		if (!request) throw new Error("expected claimed Supervisor request");
		return { id, request };
	}

	it("replaces rejected instructions, records fixed hidden feedback, and does not retry", async () => {
		const { id, request } = postAndClaim("goal_idle_review", { objective: "finish" });
		const fake = createFakeResidentSession(tempDir, [
			{ kind: "continue", reason: "local gap", instructions: REJECTED_INSTRUCTION },
		]);
		const reviewInstructions: SupervisorInstructionReviewer = async (instructions) => {
			expect(instructions).toBe(REJECTED_INSTRUCTION);
			return "reject_task_assignment";
		};

		await processSupervisorRequest(controlDbPath, request, fake.session, reviewInstructions);

		expect(fake.promptCount()).toBe(1);
		expect(readSupervisorRequest(controlDbPath, id)).toMatchObject({
			response: { kind: "continue", instructions: GENERIC_GOAL_CONTINUATION, reason: "local gap" },
			status: "completed",
		});
		expect(fake.sendCustomMessage).toHaveBeenCalledWith({
			content: supervisorInstructionRejectionFeedback("reject_task_assignment"),
			customType: "supervisor_policy_feedback",
			details: { reason: "reject_task_assignment" },
			display: false,
		});
		expect(JSON.stringify(fake.sendCustomMessage.mock.calls)).not.toContain(REJECTED_INSTRUCTION);
	});

	it("keeps an accepted completion-review observation unchanged", async () => {
		const { id, request } = postAndClaim("goal_completion_review", {
			completionReport: "Not finished.",
			objective: "finish",
		});
		const fake = createFakeResidentSession(tempDir, [
			{ kind: "continue", reason: "missing proof", instructions: ACCEPTED_INSTRUCTION },
		]);
		const reviewInstructions = vi.fn<SupervisorInstructionReviewer>(async () => "accept");

		await processSupervisorRequest(controlDbPath, request, fake.session, reviewInstructions);

		expect(reviewInstructions).toHaveBeenCalledOnce();
		expect(readSupervisorRequest(controlDbPath, id)).toMatchObject({
			response: { kind: "continue", instructions: ACCEPTED_INSTRUCTION, reason: "missing proof" },
			status: "completed",
		});
		expect(fake.sendCustomMessage).not.toHaveBeenCalled();
	});

	it("bypasses the gate for exact generic continuation and advisory responses", async () => {
		const reviewInstructions = vi.fn<SupervisorInstructionReviewer>(async () => "reject_task_assignment");
		const fake = createFakeResidentSession(tempDir, [
			{ kind: "continue", reason: "keep going", instructions: GENERIC_GOAL_CONTINUATION },
			{ kind: "advisory", answer: REJECTED_INSTRUCTION },
		]);
		const goal = postAndClaim("goal_idle_review", { objective: "finish" });
		await processSupervisorRequest(controlDbPath, goal.request, fake.session, reviewInstructions);
		const advisory = postAndClaim("supervisor_advisory", { question: "What remains?" });
		await processSupervisorRequest(controlDbPath, advisory.request, fake.session, reviewInstructions);

		expect(reviewInstructions).not.toHaveBeenCalled();
		expect(readSupervisorRequest(controlDbPath, goal.id)).toMatchObject({
			response: { kind: "continue", instructions: GENERIC_GOAL_CONTINUATION },
		});
		expect(readSupervisorRequest(controlDbPath, advisory.id)).toMatchObject({
			response: { kind: "advisory", answer: REJECTED_INSTRUCTION },
		});
	});

	it("fails closed when no reviewer is supplied", async () => {
		const { id, request } = postAndClaim("goal_idle_review", { objective: "finish" });
		const fake = createFakeResidentSession(tempDir, [
			{ kind: "continue", reason: "local gap", instructions: REJECTED_INSTRUCTION },
		]);

		await processSupervisorRequest(controlDbPath, request, fake.session);

		expect(readSupervisorRequest(controlDbPath, id)).toMatchObject({
			response: { kind: "continue", instructions: GENERIC_GOAL_CONTINUATION, reason: "local gap" },
		});
	});

	it.each([
		[
			"invalid_response",
			async (): Promise<undefined> => undefined,
			"Policy gate failure: invalid_response. Non-generic instructions were suppressed.",
		],
		[
			"evaluation_error",
			async (): Promise<undefined> => {
				throw new Error("veto unavailable");
			},
			"Policy gate failure: evaluation_error. Non-generic instructions were suppressed.",
		],
	] as const)("fails closed on %s without leaking instructions", async (failure, reviewInstructions, feedback) => {
		const { id, request } = postAndClaim("goal_idle_review", { objective: "finish" });
		const fake = createFakeResidentSession(tempDir, [
			{ kind: "continue", reason: "local gap", instructions: REJECTED_INSTRUCTION },
		]);

		await processSupervisorRequest(controlDbPath, request, fake.session, reviewInstructions);

		expect(readSupervisorRequest(controlDbPath, id)).toMatchObject({
			response: { kind: "continue", instructions: GENERIC_GOAL_CONTINUATION, reason: "local gap" },
		});
		expect(fake.sendCustomMessage).toHaveBeenCalledWith({
			content: feedback,
			customType: "supervisor_policy_feedback",
			details: { failure },
			display: false,
		});
		expect(JSON.stringify(fake.sendCustomMessage.mock.calls)).not.toContain(REJECTED_INSTRUCTION);
	});
});

describe("Supervisor instruction veto lifecycle", () => {
	let tempDir: string;
	let controlDbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-supervisor-instruction-veto-"));
		controlDbPath = getControlDbPath(tempDir);
	});

	afterEach(() => {
		rmSync(tempDir, { force: true, recursive: true });
	});

	function postAndClaim(kind: SupervisorRequestKind, payload: Record<string, unknown>): ClaimedRequest {
		const id = postSupervisorRequest(controlDbPath, {
			deadlineAt: new Date(Date.now() + 30_000).toISOString(),
			kind,
			payload,
			projectId: "pi",
			senderSessionId: "main",
		});
		const request = claimNextSupervisorRequest(controlDbPath, "runtime");
		if (!request) throw new Error("expected claimed Supervisor request");
		return { id, request };
	}

	it("preserves veto feedback during resident compaction", async () => {
		const { request } = postAndClaim("goal_idle_review", { objective: "finish" });
		const fake = createFakeResidentSession(tempDir, [{ kind: "complete", reason: "done" }]);
		const compact = vi.fn(async () => {});
		const session = {
			...fake.session,
			compact,
			getContextUsage: () => ({ percent: 80 }),
		};

		await processSupervisorRequest(controlDbPath, request, session);

		expect(compact).toHaveBeenCalledWith(
			"Preserve Supervisor decisions, project-specific policies, instruction-veto policy feedback, and reusable approval rationale.",
		);
	});

	it("aborts an in-flight veto and requeues its goal review when approval arrives", async () => {
		const goalId = postSupervisorRequest(controlDbPath, {
			deadlineAt: new Date(Date.now() + 120_000).toISOString(),
			kind: "goal_idle_review",
			payload: { objective: "finish" },
			projectId: "pi",
			senderSessionId: "main",
		});
		const request = claimNextSupervisorRequest(controlDbPath, "runtime");
		if (!request) throw new Error("expected goal review");
		const fake = createFakeResidentSession(tempDir, [
			{ kind: "continue", reason: "local gap", instructions: REJECTED_INSTRUCTION },
		]);
		let vetoSignal: AbortSignal | undefined;
		let markVetoStarted!: () => void;
		const vetoStarted = new Promise<void>((resolve) => {
			markVetoStarted = resolve;
		});
		const reviewInstructions: SupervisorInstructionReviewer = async (_instructions, signal) => {
			vetoSignal = signal;
			markVetoStarted();
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			throw new Error("veto aborted");
		};

		const processing = processSupervisorRequest(controlDbPath, request, fake.session, reviewInstructions);
		await vetoStarted;
		postSupervisorRequest(controlDbPath, {
			deadlineAt: new Date(Date.now() + 30_000).toISOString(),
			kind: "approval_review",
			payload: { toolName: "write" },
			projectId: "pi",
			senderSessionId: "other",
		});
		await processing;

		expect(vetoSignal?.aborted).toBe(true);
		expect(readSupervisorRequest(controlDbPath, goalId)).toMatchObject({ status: "pending" });
		expect(fake.sendCustomMessage).not.toHaveBeenCalled();
		expect(claimNextSupervisorRequest(controlDbPath, "runtime-2")).toMatchObject({ kind: "approval_review" });
	});
});
