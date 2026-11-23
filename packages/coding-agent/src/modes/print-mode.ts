/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { getAssistantContentText } from "../core/assistant-narration.ts";
import { flushRawStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../core/output-guard.ts";
import { isDuplicateTurnGuardMessage } from "../core/runtime-message-markers.ts";
import { getControlDbPath } from "../core/session-control-db.ts";
import { killTrackedDetachedChildren, shutdownSignals, signalExitCode } from "../utils/shell.ts";
import { toJsonPrintModeEvent } from "./json-event.ts";
import { takeUnreportedDiagnostics, writeDiagnosticsToStderr } from "./runtime-diagnostics.ts";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

function findLastPrintableAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message === undefined) throw new Error("Message missing while finding last printable assistant message");
		// A rejected end_turn (for example a blank reason) is retried; neither result ends the answer search.
		if (message.role === "toolResult" && message.toolName === "end_turn") continue;
		// Extension notes appended after the turn (e.g. from turn_end) and the duplicate-turn nudge do not end it.
		if (message.role === "custom" || isDuplicateTurnGuardMessage(message)) continue;
		if (message.role !== "assistant") return undefined;
		// A truncated response is reported even when the limit hit before any visible text.
		if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length")
			return message;
		if (message.content.some((content) => getAssistantContentText(content))) return message;
		if (message.content.some((content) => content.type === "toolCall" && content.name === "end_turn")) continue;
		return undefined;
	}
	return undefined;
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	let shutdownComplete: Promise<void> | undefined;
	let shutdownSignalSeen = false;
	const signalCleanupHandlers: Array<() => void> = [];

	// Normal exit and the first signal wait for the same cleanup and output drain.
	const disposeAndFlush = (): Promise<void> => {
		// Stay subscribed while disposing so JSON mode still writes events from session_shutdown handlers.
		shutdownComplete ??= (async () => {
			await runtimeHost.dispose();
			unsubscribe?.();
			unsubscribeBackpressure?.();
			await flushRawStdout();
		})();
		return shutdownComplete;
	};

	const registerSignalHandlers = (): void => {
		for (const signal of shutdownSignals()) {
			const handler = () => {
				// A repeated signal exits at once (#11752).
				if (shutdownSignalSeen) process.exit(signalExitCode(signal));
				shutdownSignalSeen = true;
				killTrackedDetachedChildren();
				void disposeAndFlush().finally(() => {
					process.exit(signalExitCode(signal));
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(() => rebindSession());

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		writeDiagnosticsToStderr(takeUnreportedDiagnostics(runtimeHost));
		// Subscribe before binding so events emitted by session_start handlers reach the JSON output.
		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(toJsonPrintModeEvent(event))}\n`);
			}
		});
		// Agent events wait for queued JSONL, so a blocked reader pauses model work instead of growing the queue.
		unsubscribeBackpressure =
			mode === "json" ? session.agent.subscribe(() => waitForRawStdoutBackpressure()) : undefined;
		await session.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			controlDbPath: getControlDbPath(),
			commandContextActions: {
				showApprovalSelector: () => {},
				showSandboxSelector: () => {},
				waitForIdle: () => session.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await runtimeHost.reload();
				},
				restart: async (restartOptions) => {
					await runtimeHost.restart(restartOptions);
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		// An extension command or input hook can handle the last prompt without a new message.
		let lastPromptAddedMessages = true;
		const trackPrompt = async (runPrompt: () => Promise<void>): Promise<void> => {
			const lastBefore = session.state.messages.at(-1);
			await runPrompt();
			lastPromptAddedMessages = session.state.messages.at(-1) !== lastBefore;
		};
		if (initialMessage) {
			await trackPrompt(() => session.prompt(initialMessage, { images: initialImages }));
		}

		for (const message of messages) {
			await trackPrompt(() => session.prompt(message));
		}

		// A failed reply stays the final assistant message even when a later input was handled locally.
		const assistantMsg = findLastPrintableAssistant(session.state.messages);
		if (assistantMsg?.stopReason === "error" || assistantMsg?.stopReason === "aborted") {
			console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
			exitCode = 1;
		} else if (mode === "text" && assistantMsg && lastPromptAddedMessages) {
			for (const content of assistantMsg.content) {
				const text = getAssistantContentText(content);
				if (text !== undefined) writeRawStdout(`${text}\n`);
			}
			if (assistantMsg.stopReason === "length") {
				console.error("Response was truncated: the model reached its output token limit.");
				exitCode = 1;
			}
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		// A repeated signal can still exit at once if the reader stops draining stdout.
		await disposeAndFlush();
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
	}
}
