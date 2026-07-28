import type {
	EntryRenderer,
	ExtensionAPI,
	ExtensionContext,
	MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import type { WaitCountdownRefresher } from "./wait-countdown.ts";

const SUPERVISOR_INSTRUCTION_OPEN = "<supervisor-instruction>";
const SUPERVISOR_INSTRUCTION_CLOSE = "</supervisor-instruction>";
const SUPERVISOR_STATUS_TYPE = "supervisor-status";
const REVIEW_DUE_TEXT = "Review due…";

type TextStyle = (text: string) => string;

interface SupervisorStatusStyles {
	background: TextStyle;
	countdown: TextStyle;
	label: TextStyle;
	message: TextStyle;
}

class SupervisorStatusComponent extends Box {
	private readonly countdownText: Text | undefined;
	private readonly deadlineMs: number | undefined;
	private readonly styleCountdown: TextStyle;

	constructor(message: string, reviewAt: string | undefined, styles: SupervisorStatusStyles) {
		super(1, 1, styles.background);
		this.styleCountdown = styles.countdown;
		this.deadlineMs = reviewAt === undefined ? undefined : Date.parse(reviewAt);
		this.addChild(new Text(styles.label("[Supervisor]"), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(styles.message(message), 0, 0));
		this.countdownText = Number.isFinite(this.deadlineMs) ? new Text("", 0, 0) : undefined;
		if (this.countdownText) this.addChild(this.countdownText);
	}

	override render(width: number): string[] {
		if (this.countdownText && this.deadlineMs !== undefined) {
			this.countdownText.setText(this.styleCountdown(formatReviewCountdown(this.deadlineMs, Date.now())));
		}
		return super.render(width);
	}
}

export interface SupervisorStatusController {
	append(ctx: ExtensionContext, message: string, reviewAt?: string): void;
	clearAll(): void;
	clearSession(sessionId: string): void;
	restore(ctx: ExtensionContext): void;
}

export type AppendSupervisorStatus = SupervisorStatusController["append"];

export function supervisorInstructionContent(instructions: string): string {
	return `${SUPERVISOR_INSTRUCTION_OPEN}\n${instructions}\n${SUPERVISOR_INSTRUCTION_CLOSE}`;
}

function supervisorMessage(content: string): { customType: string; content: string; display: true } {
	return {
		customType: "supervisor",
		content: supervisorInstructionContent(content),
		display: true,
	};
}

export function sendSupervisorInstructions(pi: ExtensionAPI, instructions: string): void {
	pi.sendMessage(supervisorMessage(instructions), { deliverAs: "followUp", triggerTurn: true });
}

function hasSupervisorInstructionWrapper(content: string): boolean {
	return content.startsWith(SUPERVISOR_INSTRUCTION_OPEN) && content.endsWith(SUPERVISOR_INSTRUCTION_CLOSE);
}

function supervisorInstructionBody(content: string): string {
	if (!hasSupervisorInstructionWrapper(content)) return content;
	let body = content.slice(SUPERVISOR_INSTRUCTION_OPEN.length, -SUPERVISOR_INSTRUCTION_CLOSE.length);
	if (body.startsWith("\n")) body = body.slice(1);
	if (body.endsWith("\n")) body = body.slice(0, -1);
	return body;
}

function statusDetails(data: unknown): { message: string; reviewAt: string | undefined } {
	if (typeof data !== "object" || data === null) {
		return { message: "Supervisor status unavailable", reviewAt: undefined };
	}
	const details = data as { message?: unknown; reviewAt?: unknown };
	return {
		message: typeof details.message === "string" ? details.message : "Supervisor status unavailable",
		reviewAt: typeof details.reviewAt === "string" ? details.reviewAt : undefined,
	};
}

function formatReviewCountdown(deadlineMs: number, nowMs: number): string {
	const remainingMs = deadlineMs - nowMs;
	if (remainingMs <= 0) return REVIEW_DUE_TEXT;
	const remainingSeconds = Math.ceil(remainingMs / 1_000);
	const minutes = Math.floor(remainingSeconds / 60);
	const seconds = String(remainingSeconds % 60).padStart(2, "0");
	return `Next review in ${minutes}:${seconds}`;
}

function latestFutureReviewAt(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== SUPERVISOR_STATUS_TYPE) continue;
		const { reviewAt } = statusDetails(entry.data);
		if (!reviewAt) return undefined;
		const deadlineMs = Date.parse(reviewAt);
		return Number.isFinite(deadlineMs) && deadlineMs > Date.now() ? reviewAt : undefined;
	}
	return undefined;
}

export function createSupervisorStatusController(
	pi: ExtensionAPI,
	refresher: WaitCountdownRefresher,
): SupervisorStatusController {
	return {
		append(ctx, message, reviewAt) {
			const sessionId = ctx.sessionManager.getSessionId();
			refresher.clearSession(sessionId);
			pi.appendEntry(SUPERVISOR_STATUS_TYPE, reviewAt ? { message, reviewAt } : { message });
			if (reviewAt) refresher.start(ctx, reviewAt);
		},
		clearAll: () => refresher.clearAll(),
		clearSession: (sessionId) => refresher.clearSession(sessionId),
		restore(ctx) {
			const sessionId = ctx.sessionManager.getSessionId();
			refresher.clearSession(sessionId);
			const reviewAt = latestFutureReviewAt(ctx);
			if (reviewAt) refresher.start(ctx, reviewAt);
		},
	};
}

export const renderSupervisorStatusEntry: EntryRenderer = (entry, _rendererOptions, theme) => {
	const { message, reviewAt } = statusDetails(entry.data);
	return new SupervisorStatusComponent(message, reviewAt, {
		background: (text) => theme.bg("customMessageBg", text),
		countdown: (text) => theme.fg("dim", text),
		label: (text) => theme.fg("customMessageLabel", theme.bold(text)),
		message: (text) => theme.fg("customMessageText", text),
	});
};

export const renderSupervisorMessage: MessageRenderer = (message, _rendererOptions, theme) => {
	const content = typeof message.content === "string" ? message.content : "";
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[Supervisor]")), 0, 0));
	box.addChild(new Spacer(1));
	box.addChild(new Text(theme.fg("customMessageText", supervisorInstructionBody(content)), 0, 0));
	return box;
};
