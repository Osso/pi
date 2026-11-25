import { randomUUID } from "node:crypto";
import { getAgentDir } from "../../../src/config.ts";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "../../../src/core/extensions/types.ts";
import {
	claimNextSupervisorRequest,
	hasPendingSupervisorApprovalRequest,
	listQuestionRequests,
	readSupervisorRequest,
	recoverSupervisorRequests,
	type SupervisorRequest,
} from "../../../src/core/session-control-db.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { askQuestionsInUi, validateQuestions } from "../../../src/core/tools/ask-questions.ts";
import { deliverSupervisorMail, ingestSupervisorRequestMail } from "../../../src/supervisor/mail.ts";
import { answerQuestionAsUser } from "../../../src/supervisor/question-answers.ts";
import {
	applySupervisorInstructionVeto,
	createSupervisorInstructionEvaluator,
	createSupervisorInstructionReviewer,
	evaluateAndCompleteSupervisorRequest,
	type SupervisorInstructionReviewer,
} from "../../../src/supervisor/request-evaluation.ts";
import { notifySupervisorRequest, SupervisorRequestWakeServer } from "../../../src/supervisor/request-wake.ts";
import { createSupervisorResponseTool, SUPERVISOR_RESPONSE_TOOL_NAME } from "../../../src/supervisor/response-tool.ts";
import { SUPERVISOR_REQUEST_POLICY, type SupervisorEvaluator } from "../../../src/supervisor/service.ts";
import { registerAskCommand } from "./ask-command.ts";
import { DueTaskDelivery, type DueTaskOptions, readLlmTasksToken } from "./due-tasks.ts";
import { createInspectSessionTool } from "./inspect-session-tool.ts";
import { renderSupervisorRequestMessage } from "./request-message.ts";

export const SUPERVISOR_REQUEST_MESSAGE_TYPE = "supervisor_request";
export const SUPERVISOR_RESUME_MESSAGE_TYPE = "supervisor_resume";

/** Every tool the Supervisor session may call, in user chat and request turns alike. */
export const SUPERVISOR_SESSION_TOOL_NAMES = [
	"read",
	"edit",
	"write",
	SUPERVISOR_RESPONSE_TOOL_NAME,
	"inspect_session",
	"send_agent_message",
	"ask_questions",
	"end_turn",
];

const CHAT_RESPONSE_BLOCK =
	"supervisor_response answers [Supervisor request] messages only. Answer the user's message in plain text.";

const RESUME_INTERRUPTED_TURN =
	"Your previous turn was interrupted so a Supervisor approval request could be answered. Continue that turn.";

export function isSupervisorSession(ctx: ExtensionContext): boolean {
	const sessionId = ctx.settingsManager?.getMergedSettings().supervisor?.sessionId;
	return sessionId !== undefined && sessionId === ctx.sessionManager.getSessionId();
}

/** Restricts the session's tools to the allow-list. */
export function blockSupervisorSessionTool(event: { toolName: string }): ToolCallEventResult | undefined {
	if (SUPERVISOR_SESSION_TOOL_NAMES.includes(event.toolName)) return undefined;
	return { block: true, reason: `The Supervisor session cannot use ${event.toolName}.` };
}

/** The arguments of the last `supervisor_response` call after `previousLeafId`, which marks the request boundary. */
export function readSupervisorResponseAfter(entries: SessionEntry[], previousLeafId: string | null): unknown {
	const boundary = previousLeafId ? entries.findIndex((entry) => entry.id === previousLeafId) : -1;
	if (previousLeafId && boundary === -1) throw new Error("Supervisor request boundary is missing from the branch");
	let response: unknown;
	let failedRequest: string | undefined;
	for (const entry of entries.slice(boundary + 1)) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		failedRequest = entry.message.stopReason === "error" ? entry.message.errorMessage : undefined;
		for (const part of entry.message.content) {
			if (part.type === "toolCall" && part.name === SUPERVISOR_RESPONSE_TOOL_NAME) response = part.arguments;
		}
	}
	if (response !== undefined) return response;
	// A failed model request is the cause; reporting only the missing call hid it (for example an
	// exhausted provider account).
	if (failedRequest) throw new Error(`Supervisor model request failed: ${failedRequest}`);
	throw new Error("Supervisor turn ended without a supervisor_response call");
}

/**
 * Serves the durable Supervisor request queue from the interactive session named by `supervisor.sessionId`.
 *
 * Requests run as turns of this session between user turns, in queue priority order. A pending approval
 * aborts a running user turn; that turn is resumed after the queue drains.
 */
class SupervisorSessionServer {
	private readonly pi: ExtensionAPI;
	private readonly claimToken = randomUUID();
	private abortController: AbortController | undefined;
	private wakeServer: SupervisorRequestWakeServer | undefined;
	private controlDbPath: string | undefined;
	private turnEndWaiters: Array<() => void> = [];
	private chatInterrupted = false;
	/** True while a request turn runs; only then may the model call supervisor_response. */
	servingRequest = false;
	private reviewInstructions: SupervisorInstructionReviewer | undefined;
	/** Escalated questions open in the UI, by request ID; closed when the asker answers locally. */
	private readonly openEscalations = new Map<number, AbortController>();

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	get active(): boolean {
		return this.abortController !== undefined;
	}

	async start(ctx: ExtensionContext): Promise<void> {
		await this.stop();
		if (!isSupervisorSession(ctx)) return;
		const controlDbPath = ctx.controlDbPath;
		if (!controlDbPath) throw new Error("The Supervisor session requires the Pi control database.");
		this.pi.registerTool(createSupervisorResponseTool());
		this.pi.registerTool(createInspectSessionTool());
		const available = new Set(this.pi.getAllTools().map((tool) => tool.name));
		this.pi.setActiveTools(SUPERVISOR_SESSION_TOOL_NAMES.filter((name) => available.has(name)));
		const wakeServer = new SupervisorRequestWakeServer(controlDbPath);
		await wakeServer.start();
		this.controlDbPath = controlDbPath;
		this.wakeServer = wakeServer;
		this.abortController = new AbortController();
		void this.serve(ctx, controlDbPath, wakeServer, this.abortController.signal).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Supervisor request loop stopped: ${message}`, "error");
		});
	}

	async stop(): Promise<void> {
		this.abortController?.abort();
		this.abortController = undefined;
		this.releaseTurnWaiters();
		await this.wakeServer?.close();
		this.wakeServer = undefined;
	}

	onAgentSettled(): void {
		if (!this.active || !this.controlDbPath) return;
		this.releaseTurnWaiters();
		// The wake arrives after the run settles, so the loop sees the session idle.
		notifySupervisorRequest(this.controlDbPath);
	}

	private releaseTurnWaiters(): void {
		const waiters = this.turnEndWaiters;
		this.turnEndWaiters = [];
		for (const resolve of waiters) resolve();
	}

	private async serve(
		ctx: ExtensionContext,
		controlDbPath: string,
		wakeServer: SupervisorRequestWakeServer,
		signal: AbortSignal,
	): Promise<void> {
		recoverSupervisorRequests(controlDbPath);
		this.reopenEscalations(ctx, controlDbPath);
		while (!signal.aborted) {
			const generation = wakeServer.currentGeneration();
			await this.serveAvailableWork(ctx, controlDbPath);
			await wakeServer.waitForWakeAfter(generation, signal);
		}
	}

	private async serveAvailableWork(ctx: ExtensionContext, controlDbPath: string): Promise<void> {
		this.closeWithdrawnEscalations(controlDbPath);
		if (!ctx.isIdle()) {
			if (hasPendingSupervisorApprovalRequest(controlDbPath)) {
				this.chatInterrupted = true;
				ctx.abort();
			}
			return;
		}
		while (this.active && ctx.isIdle() && !ctx.hasPendingMessages()) {
			const request = claimNextSupervisorRequest(controlDbPath, this.claimToken);
			if (!request) break;
			const evaluator = this.createEvaluator(ctx, request);
			await evaluateAndCompleteSupervisorRequest(
				controlDbPath,
				request,
				evaluator,
				ctx.sessionManager.getSessionId(),
			);
			if (request.kind === "question") this.askUserAfterEscalation(ctx, controlDbPath, request);
		}
		if (this.chatInterrupted && ctx.isIdle()) {
			this.chatInterrupted = false;
			this.pi.sendMessage(
				{ customType: SUPERVISOR_RESUME_MESSAGE_TYPE, content: RESUME_INTERRUPTED_TURN, display: true },
				{ triggerTurn: true },
			);
		}
	}

	/**
	 * A withdrawal or an answer given elsewhere (the asker's panel, the `pi questions` CLI) arrives as a
	 * wake; its panel closes so the user cannot answer it twice.
	 */
	private closeWithdrawnEscalations(controlDbPath: string): void {
		for (const [requestId, controller] of this.openEscalations) {
			if (readSupervisorRequest(controlDbPath, requestId)?.status !== "escalated") controller.abort();
		}
	}

	/** Escalated questions stay open in the store across restarts; their panels open again here. */
	private reopenEscalations(ctx: ExtensionContext, controlDbPath: string): void {
		for (const request of listQuestionRequests(controlDbPath).reverse()) {
			if (!this.openEscalations.has(request.id)) this.askUserAfterEscalation(ctx, controlDbPath, request);
		}
	}

	/** A question the Supervisor escalated, or failed to decide, opens here for the user to answer. */
	private askUserAfterEscalation(ctx: ExtensionContext, controlDbPath: string, request: SupervisorRequest): void {
		const escalated = readSupervisorRequest(controlDbPath, request.id);
		if (escalated?.status !== "escalated" || !escalated.replyTo) return;
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		const questions = request.payload.questions as Parameters<typeof askQuestionsInUi>[1];
		validateQuestions(questions);
		const withdrawn = new AbortController();
		this.openEscalations.set(request.id, withdrawn);
		void askQuestionsInUi(ctx, questions, withdrawn.signal)
			// Cancelling the panel leaves the question open in the store for `pi questions` or a restart.
			.then(({ answers, cancelled }) => {
				if (!cancelled) answerQuestionAsUser(controlDbPath, ctx.sessionManager.getSessionId(), request.id, answers);
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Escalated question ${request.id} failed: ${message}`, "error");
			})
			.finally(() => this.openEscalations.delete(request.id));
	}

	private createEvaluator(ctx: ExtensionContext, request: SupervisorRequest): SupervisorEvaluator {
		return async (prompt, signal) => {
			const abort = () => {
				ctx.abort();
				this.releaseTurnWaiters();
			};
			signal.addEventListener("abort", abort, { once: true });
			try {
				if (signal.aborted) throw new Error("Supervisor request aborted");
				const previousLeafId = ctx.sessionManager.getLeafId();
				const turnEnded = new Promise<void>((resolve) => this.turnEndWaiters.push(resolve));
				this.servingRequest = true;
				this.pi.sendMessage(
					{
						customType: SUPERVISOR_REQUEST_MESSAGE_TYPE,
						content: prompt,
						display: true,
						details: { id: request.id },
					},
					{ triggerTurn: true },
				);
				await turnEnded;
				if (signal.aborted) throw new Error("Supervisor request aborted");
				const rawResponse = readSupervisorResponseAfter(ctx.sessionManager.getBranch(), previousLeafId);
				const feedbackTarget = {
					sendCustomMessage: async (message: { customType: string; content: string; display: boolean }) =>
						this.pi.sendMessage(message),
				};
				return applySupervisorInstructionVeto(
					request,
					rawResponse,
					feedbackTarget,
					this.instructionReviewer(ctx),
					signal,
				);
			} finally {
				this.servingRequest = false;
				signal.removeEventListener("abort", abort);
			}
		};
	}

	/** Built on first use: only non-generic goal continuations reach the veto gate, which needs its own model. */
	private instructionReviewer(ctx: ExtensionContext): SupervisorInstructionReviewer {
		return (instructions, signal) => {
			this.reviewInstructions ??= createSupervisorInstructionReviewer(
				createSupervisorInstructionEvaluator(ctx.modelRegistry, getAgentDir(), ctx.cwd),
			);
			return this.reviewInstructions(instructions, signal);
		};
	}
}

export default function supervisorSessionExtension(pi: ExtensionAPI, options: Partial<DueTaskOptions> = {}): void {
	const server = new SupervisorSessionServer(pi);
	const dueTasks = new DueTaskDelivery(pi, {
		intervalMs: options.intervalMs ?? 60_000,
		readToken: options.readToken ?? readLlmTasksToken,
	});
	pi.registerMessageRenderer(SUPERVISOR_REQUEST_MESSAGE_TYPE, renderSupervisorRequestMessage);
	registerAskCommand(pi);
	pi.registerToolGate((event, ctx) => {
		if (!isSupervisorSession(ctx)) return undefined;
		if (event.toolName === SUPERVISOR_RESPONSE_TOOL_NAME && !server.servingRequest) {
			return { block: true, reason: CHAT_RESPONSE_BLOCK };
		}
		return blockSupervisorSessionTool(event);
	});
	pi.on("before_agent_start", (event, ctx) =>
		isSupervisorSession(ctx) ? { systemPrompt: `${event.systemPrompt}\n\n${SUPERVISOR_REQUEST_POLICY}` } : undefined,
	);
	pi.on("session_start", async (_event, ctx) => {
		const tasksUrl = ctx.settingsManager?.getMergedSettings().supervisor?.tasksUrl;
		dueTasks.start(ctx, isSupervisorSession(ctx) ? tasksUrl : undefined);
		await server.start(ctx);
	});
	pi.on("session_shutdown", async () => {
		dueTasks.stop();
		await server.stop();
	});
	// A failed attempt ends a run before its automatic retry; the request turn is over, and a reminder queued for
	// it is written or dropped, only once the run settles.
	pi.on("agent_settled", async (_event, ctx) => {
		server.onAgentSettled();
		await dueTasks.settle(ctx);
	});
	pi.on("runtime_mailbox", (event, ctx) => {
		const controlDbPath = ctx.controlDbPath;
		const ingested =
			controlDbPath !== undefined &&
			isSupervisorSession(ctx) &&
			ingestSupervisorRequestMail(controlDbPath, event.message);
		return { handled: ingested || deliverSupervisorMail(event.message) };
	});
}
