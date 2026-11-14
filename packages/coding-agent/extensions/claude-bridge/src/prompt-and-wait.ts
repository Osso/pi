import { type EffortLevel, query, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Context } from "@earendil-works/pi-ai";
import { claudeExecutable, errorMessage, prepareProviderAccount, providerSettings } from "./account-runtime.ts";
import type { AskClaudeMode } from "./askclaude-schema.ts";
import type { ToolCallState } from "./askclaude-ui.ts";
import { recordAuthFailure } from "./auth-trace.ts";
import { claudeCodeSettings } from "./config.ts";
import { debug, makeCliDebugOptions } from "./diagnostics.ts";
import { CC_CHILD_ENV, longContextSettings, resultErrorText } from "./isolated-summary.ts";
import { type buildModels, claudeCodeModelId, resolveModel } from "./models.ts";
import { collectPromptSkills, type sharedPromptCaptures } from "./prompt-capture.ts";
import { sessionStateFor, syncSharedSession } from "./session-mirror.ts";
import { renderSkillsBlock } from "./skills.ts";
import { mapToolName } from "./stream-events.ts";

export const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"];

export type PromptCaptureStore = ReturnType<typeof sharedPromptCaptures>;
export interface PromptAndWaitDependencies {
	models: ReturnType<typeof buildModels>;
	promptCaptures: PromptCaptureStore;
	query: typeof query;
}
let askClaudeQueryImpl: typeof query = query;
export function setAskClaudeQueryImpl(fn: typeof query | null): void {
	askClaudeQueryImpl = fn ?? query;
}

export function getAskClaudeQueryImpl(): typeof query {
	return askClaudeQueryImpl;
}

const ASKCLAUDE_ALWAYS_BLOCKED = [
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"ToolSearch", // probes for blocked tools, wastes tokens
	"ScheduleWakeup", // no harness to fire wakeup from inside a delegated subagent
];
const MODE_DISALLOWED_TOOLS: Record<AskClaudeMode, string[]> = {
	full: ASKCLAUDE_ALWAYS_BLOCKED,
	read: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
		"Write",
		"Edit",
		"Bash",
		"NotebookEdit",
		"EnterWorktree",
		"ExitWorktree",
		"CronCreate",
		"CronDelete",
		"TeamCreate",
		"TeamDelete",
	],
	none: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
		"Read",
		"Write",
		"Edit",
		"Glob",
		"Grep",
		"Bash",
		"Agent",
		"NotebookEdit",
		"EnterWorktree",
		"ExitWorktree",
		"CronCreate",
		"CronDelete",
		"TeamCreate",
		"TeamDelete",
		"WebFetch",
		"WebSearch",
	],
};

export const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "max",
};

// --- AskClaude: prompt and wait ---

export async function promptAndWait(
	dependencies: PromptAndWaitDependencies,
	cwd: string,
	prompt: string,
	mode: "full" | "read" | "none",
	toolCalls: Map<string, ToolCallState>,
	signal?: AbortSignal,
	options?: {
		systemPrompt?: string;
		appendSkills?: boolean;
		onStreamUpdate?: (responseText: string) => void;
		model?: string;
		thinking?: string;
		isolated?: boolean;
		context?: Context["messages"];
		/** pi session the calling tool ran in — AskClaude's conversation continues
		 *  the session that called it, so its sync and capture key that mirror. */
		piSessionId?: string | null;
	},
): Promise<{ responseText: string; stopReason: string }> {
	const requestedModel = options?.model ?? "opus";
	const model = resolveModel(dependencies.models, requestedModel);
	const modelId = model?.id ?? requestedModel;
	const account = prepareProviderAccount();
	const cliModel = model ? claudeCodeModelId(model, longContextSettings) : modelId;

	// Session resume for shared mode — reuse provider's session if it exists,
	// otherwise create one from pi's context.
	// Note: doesn't update the mirror's cursor after completion, so the next
	// provider call will see missed messages and trigger a Case 4 rebuild.
	// AskClaude has a random-origin context handed to it, but the session it
	// belongs to is the one whose tool ran — the extension API's execute ctx
	// carries it — passed here as piSessionId and used for every map access.
	const askClaudeSessionId = options?.piSessionId ?? null;
	let resumeSessionId: string | null = null;
	if (!options?.isolated && options?.context?.length) {
		const askClaudeState = sessionStateFor(askClaudeSessionId);
		if (askClaudeState) {
			// Provider already has a session — just resume from it
			// Any missed messages from other providers were already handled by the provider's Case 4
			resumeSessionId = askClaudeState.sessionId;
		} else {
			// No provider session yet — create one from pi's context
			const contextWithPrompt = [
				...options.context,
				{ role: "user" as const, content: prompt, timestamp: Date.now() },
			];
			const sync = syncSharedSession(
				contextWithPrompt as Context["messages"],
				cwd,
				undefined,
				cliModel,
				askClaudeSessionId,
			);
			resumeSessionId = sync.sessionId;
		}
	}

	// Mode → disallowed tools
	const disallowedTools = MODE_DISALLOWED_TOOLS[mode];

	// AskClaude uses Claude Code's native Read tool rather than Pi's MCP bridge.
	// Same resolver as the provider path: a prompt neither recorded nor derivable
	// throws here too, rather than silently sending Claude Code no skills.
	//
	// Resolved only when the answer would be used. The throw is justified by what a
	// miss would cost, so where it costs nothing — skills switched off, or no reader
	// to open a skill file with — an unrelated miss must not fail the call.
	const skillReadTool = disallowedTools.includes("Read") ? "none" : "native";
	const skillCapture =
		options?.appendSkills !== false && skillReadTool !== "none"
			? dependencies.promptCaptures.resolveOrDerive(options?.systemPrompt)
			: undefined;
	const skillsBlock = skillCapture ? renderSkillsBlock(collectPromptSkills(skillCapture), skillReadTool) : undefined;

	// Effort
	const effort = options?.thinking && options.thinking !== "off" ? REASONING_TO_EFFORT[options.thinking] : undefined;

	const extraArgs: Record<string, string | null> = {
		"strict-mcp-config": null,
		model: cliModel,
	};
	if (effort) extraArgs["thinking-display"] = "summarized";

	debug(
		"askClaude:",
		`mode=${mode} model=${modelId} cliModel=${cliModel} effort=${effort ?? "default"}`,
		`isolated=${options?.isolated ?? false} resume=${resumeSessionId?.slice(0, 8) ?? "none"}`,
		`skills=${Boolean(skillsBlock)} promptLen=${prompt.length}`,
	);

	// skills: [] suppresses Claude Code's own skill listing, a system-reminder naming every
	// skill under the ~/.claude estate. The provider's native-tool allowlist excludes
	// Skill and its listing, but AskClaude runs on CC's native
	// tools, so it has to be asked for. Pi-side skills still arrive via skillsBlock below,
	// which is meant to be the only channel.
	const sdkQuery = dependencies.query({
		prompt,
		options: {
			cwd,
			env: { ...process.env, ...CC_CHILD_ENV, ...(account ? { CLAUDE_CONFIG_DIR: account.configDir } : {}) },
			permissionMode: "bypassPermissions",
			settings: { ...claudeCodeSettings(providerSettings), claudeMdExcludes: CLAUDE_MD_EXCLUDES },
			skills: [],
			...(disallowedTools.length ? { disallowedTools } : {}),
			...(effort ? { effort } : {}),
			// Preset unconditionally: omitting it leaves the child on the SDK's bare default,
			// without the tool and permission guidance the bridge relies on everywhere else.
			// Whether pi has skills to append is unrelated to whether the child needs that.
			systemPrompt: { type: "preset", preset: "claude_code", append: skillsBlock },
			settingSources: ["user", "project"] as SettingSource[],
			extraArgs,
			...(resumeSessionId ? { resume: resumeSessionId } : {}),
			...(options?.isolated ? { persistSession: false } : {}),
			...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
			...makeCliDebugOptions("askclaude", account),
		},
	});

	// Abort handling
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		sdkQuery.interrupt().catch(() => {
			try {
				sdkQuery.close();
			} catch {}
		});
	};
	if (signal?.aborted) {
		onAbort();
		throw new Error("Aborted");
	}
	signal?.addEventListener("abort", onAbort, { once: true });

	let responseText = "";
	let sdkMessageCount = 0;
	let textDeltaCount = 0;
	let resultSubtype: string | undefined;

	try {
		for await (const message of sdkQuery) {
			if (wasAborted) break;
			sdkMessageCount++;

			switch (message.type) {
				case "stream_event": {
					const event = message.event;
					// Text deltas → accumulate and stream
					if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
						responseText += event.delta.text;
						textDeltaCount++;
						options?.onStreamUpdate?.(responseText);
					}
					// Tool call start → track for action summary progress
					if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
						debug(`askClaude: tool_use start: ${event.content_block.name}`);
						toolCalls.set(event.content_block.id, {
							name: mapToolName(event.content_block.name),
							status: "running",
						});
					}
					break;
				}
				case "assistant": {
					// Update tool calls with full input for action summary
					for (const block of message.message?.content ?? []) {
						if (block.type === "tool_use") {
							toolCalls.set(block.id, {
								name: mapToolName(block.name),
								status: "complete",
								rawInput:
									block.input && typeof block.input === "object" && !Array.isArray(block.input)
										? (block.input as Record<string, unknown>)
										: undefined,
							});
						}
					}
					break;
				}
				case "result": {
					resultSubtype = message.subtype;
					if (message.usage) {
						debug(
							`askClaude: result usage: in=${message.usage.input_tokens} out=${message.usage.output_tokens} cacheRead=${message.usage.cache_read_input_tokens ?? 0} cacheWrite=${message.usage.cache_creation_input_tokens ?? 0} turns=${message.num_turns ?? "?"}`,
						);
					}
					// Claude Code reports an API failure with `is_error` on a result whose
					// subtype is still "success", so without this the error text was returned
					// as Claude's answer and pi's model read a 429 as content. Throwing hands
					// it to the tool's own catch, which renders it as an error result.
					const failure = wasAborted ? undefined : resultErrorText(message);
					if (failure) throw new Error(failure);
					if (!responseText && message.subtype === "success" && message.result) {
						responseText = message.result;
					}
					break;
				}
			}
		}

		const stopReason = wasAborted ? "cancelled" : "stop";
		debug(
			`askClaude: done`,
			`stopReason=${stopReason} resultSubtype=${resultSubtype ?? "none"}`,
			`sdkMessages=${sdkMessageCount} textDeltas=${textDeltaCount} responseLen=${responseText.length}`,
			`toolCalls=${toolCalls.size}`,
		);
		return { responseText, stopReason };
	} catch (error) {
		recordAuthFailure(account, errorMessage(error));
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		sdkQuery.close();
	}
}
