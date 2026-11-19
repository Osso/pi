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
import { flushRawStdout, writeRawStdout } from "../core/output-guard.ts";
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
		if (message.role === "toolResult" && message.toolName === "end_turn" && !message.isError) continue;
		// Extension notes appended after the turn (e.g. from turn_end) do not end it.
		if (message.role === "custom") continue;
		if (message.role !== "assistant") return undefined;
		if (message.stopReason === "error" || message.stopReason === "aborted") return message;
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
	let disposal: Promise<void> | undefined;
	let shutdownSignalSeen = false;
	const signalCleanupHandlers: Array<() => void> = [];

	// Every caller waits for the one in-flight disposal, so a signal during the final disposal does not cut it off.
	const disposeRuntime = (): Promise<void> => {
		disposal ??= (async () => {
			unsubscribe?.();
			await runtimeHost.dispose();
		})();
		return disposal;
	};

	const registerSignalHandlers = (): void => {
		for (const signal of shutdownSignals()) {
			const handler = () => {
				// A repeated signal exits at once (#11752).
				if (shutdownSignalSeen) process.exit(signalExitCode(signal));
				shutdownSignalSeen = true;
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
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
		unsubscribe = session.subscribe((event) => {
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(toJsonPrintModeEvent(event))}\n`);
			}
		});
		await session.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			controlDbPath: getControlDbPath(),
			commandContextActions: {
				showApprovalSelector: () => {},
				showSandboxSelector: () => {},
				waitForIdle: () => session.agent.waitForIdle(),
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

		if (initialMessage) {
			await session.prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			await session.prompt(message);
		}

		const assistantMsg = findLastPrintableAssistant(session.state.messages);
		if (assistantMsg?.stopReason === "error" || assistantMsg?.stopReason === "aborted") {
			console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
			exitCode = 1;
		} else if (mode === "text" && assistantMsg) {
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
		// Remove the signal handlers only after disposal, so a signal during it waits instead of killing pi.
		await disposeRuntime();
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await flushRawStdout();
	}
}
