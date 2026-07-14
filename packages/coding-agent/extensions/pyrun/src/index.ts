import { existsSync, statSync } from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	RuntimeMailboxEvent,
	ToolDefinition,
} from "../../../src/core/extensions/types.ts";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type SessionInfo, SessionManager } from "../../../src/core/session-manager.ts";
import { highlightCode, type Theme } from "../../../src/modes/interactive/theme/theme.ts";
import type { MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import type { ToolDetachRegistry } from "../../../src/core/tool-detach-registry.ts";
import { resolvePath } from "../../../src/utils/paths.ts";
import {
	createBwrapRunnerCommand,
	createBwrapRunnerEnvironment,
	resolveBwrapSandboxProfile,
} from "../../bwrap/src/backend.ts";
import { runDurableDetachablePyrunEvaluation } from "./detached-evaluation.ts";
import { createPyrunEvalExecutor, type PyrunEvalParams, type PyrunPiRequestDispatcher } from "./eval-tool.ts";
import {
	enqueueDetachedPyrunBridgeResponse,
	parseDetachedPyrunBridgeRequest,
	validateDetachedPyrunBridgeRequest,
} from "./detached-bridge.ts";
import {
	PyrunRunnerClient,
	type CanonicalPyrunEvalResult,
	type CanonicalPyrunProgressUpdate,
	type PyrunRunnerOptions,
	resolvePyrunRunnerOptions,
} from "./runner.ts";

export interface PyrunBackgroundJobsOptions {
	store: MultiAgentStore;
}

export interface PyrunExtensionOptions {
	backgroundJobs?: PyrunBackgroundJobsOptions;
	bwrapCommand?: string;
	detachRegistry?: ToolDetachRegistry;
	piRequestHandlers?: PyrunPiRequestDispatcher[];
}

type PyrunEvaluate = ReturnType<typeof createPyrunEvalExecutor>;

interface PyrunExecutorState {
	evaluate: PyrunEvaluate;
	key: string;
	piBridgeEnabled: boolean;
	runner: PyrunRunnerClient;
	runnerOptions: PyrunRunnerOptions;
}

const PYRUN_PROMPT_SNIPPET = "Evaluate Python through the canonical Pyrun JSONL runtime adapter";

const pyrunEvalSchema = Type.Object({
	code: Type.String({ description: "Python source to evaluate." }),
	session_id: Type.Optional(Type.String({ description: "Pyrun session id. Defaults to this Pi session." })),
});

const PYRUN_PROMPT_GUIDELINES = [
	"Pyrun evaluates Python code in a persistent Python session with a persistent ctx object.",
	"Pi delegates Python/Pyrun runtime semantics to the Pyrun JSONL runner; Pi does not implement helper behavior locally.",
	"Do not use MCP for Pi's built-in pyrun_eval path; use the JSONL runner boundary.",
	"Use pi.footer.snapshot() to read the current Pi footer snapshot inside Pyrun.",
	"Use pi.compact(...) to trigger Pi session compaction from Pyrun.",
	"Use pi.restart(...) to restart Pi and resume the same session from Pyrun.",
	"Use pi.sessions.resume({ path | id | name }) to switch Pi to a target session from Pyrun.",
	"Use pi.models.scoped() to list the current session scoped models for model cycling and pi.models.set(provider, model_id, thinking_level=None) to switch the current session model.",
	"Use pi.tools.call(name, params) to call active Pi tools from Pyrun, and pi.web_search(query) as a web_search shortcut.",
	"Use pi.commands.list() to list slash commands and pi.commands.run(name, args=\"\") to run registered slash commands from Pyrun.",
	"Use pi.agents.spawn(...), pi.agents.list(...), pi.agents.wait(), pi.agents.current(), pi.agents.select(agent_id), pi.messages.last(), pi.messages.enqueue(...), and pi.messages.send(...) for the supported Pi runtime bridge; pi.agents.wait() waits for any active agent and returns no agent output.",
	"Use Pyrun helpers directly: host, fs, cli, run, http, rg, fd, sqlite, kubectl, tools, text, seq, obj, and hr.",
	"When a bwrap sandbox profile is active, Pyrun executes inside that sandbox and Pi bridge helpers are unavailable.",
	"run.<program>(*args) executes immediately, sends stdout/stderr to the tool output by default, and returns ONLY the exit code (int). Example: `exit_code = run.git('status')`.",
	"cli.<program>(*args) returns a CommandBuilder, which supports chaining and whose `.run()` returns a full CommandResult. Use cli.* when stdout/stderr must be inspected. Example: `result = cli.git('status').run(); print(result.stdout)`.",
	"Use tools.ssh({ host, user, port, password }) for SSH commands that need password auth; it wraps sshpass automatically.",
	"run.* output is displayed through the tool output; do not expect a CommandResult from run.*. Use cli.* for captured stdout/stderr and structured command results.",
	"Agents MUST NOT rerun the same command only to recover logs; inspect the saved CommandResult/full logs instead.",
	"Do not compose shell strings for Pyrun command helpers; call argv-style helpers instead.",
];

function formatPyrunResult(text: string, executed: string | undefined, isError: boolean, theme: Theme): string {
	if (!executed) {
		return theme.fg("toolOutput", text);
	}
	if (!text.startsWith(executed)) {
		const prefix = isError && !text.startsWith("Error:") ? "Error: " : "";
		return theme.fg("toolOutput", `${prefix}${text}`);
	}
	return theme.fg("toolOutput", text.slice(executed.length).replace(/^\n+/, ""));
}

function getExecutedCode(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const executed = (details as { executed?: unknown }).executed;
	return typeof executed === "string" ? executed : undefined;
}

function readStringArg(args: unknown, key: string): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

function normalizeRestartParams(params: unknown): { notice?: string; process: true } {
	if (params === undefined || params === null) {
		return { process: true };
	}
	if (typeof params === "string") {
		return { notice: params, process: true };
	}
	if (typeof params !== "object") {
		throw new Error("pi.restart requires no argument, a notice string, or { notice } object");
	}
	const notice = (params as { notice?: unknown }).notice;
	if (notice !== undefined && typeof notice !== "string") {
		throw new Error("pi.restart notice must be a string");
	}
	return { notice, process: true };
}

function normalizeCompactParams(params: unknown): { customInstructions?: string } {
	if (params === undefined || params === null) {
		return {};
	}
	if (typeof params === "string") {
		return { customInstructions: params };
	}
	if (typeof params !== "object") {
		throw new Error("pi.compact requires no argument, a custom instructions string, or { customInstructions } object");
	}
	const customInstructions = (params as { customInstructions?: unknown }).customInstructions;
	if (customInstructions !== undefined && typeof customInstructions !== "string") {
		throw new Error("pi.compact customInstructions must be a string");
	}
	return { customInstructions };
}

interface ResumeSessionParams {
	id?: string;
	name?: string;
	path?: string;
}

function readNonEmptyString(record: Record<string, unknown>, key: keyof ResumeSessionParams): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`pi.sessions.resume ${key} must be a non-empty string`);
	}
	return value.trim();
}

function normalizeResumeSessionParams(params: unknown): ResumeSessionParams {
	if (!params || typeof params !== "object") {
		throw new Error("pi.sessions.resume requires { path }, { id }, or { name }");
	}
	const record = params as Record<string, unknown>;
	const target = {
		id: readNonEmptyString(record, "id"),
		name: readNonEmptyString(record, "name"),
		path: readNonEmptyString(record, "path"),
	};
	const targetCount = Object.values(target).filter((value) => value !== undefined).length;
	if (targetCount !== 1) {
		throw new Error("pi.sessions.resume requires exactly one of path, id, or name");
	}
	return target;
}

function assertResumeSessionPath(path: string): string {
	if (!existsSync(path) || !statSync(path).isFile()) {
		throw new Error(`Session file does not exist: ${path}`);
	}
	if (!path.endsWith(".jsonl")) {
		throw new Error(`Session file must be a .jsonl file: ${path}`);
	}
	return path;
}

function findUniqueSessionMatch(sessions: SessionInfo[], label: string, matches: (session: SessionInfo) => boolean): SessionInfo {
	const matched = sessions.filter(matches);
	if (matched.length === 0) {
		throw new Error(`No session found matching ${label}`);
	}
	if (matched.length > 1) {
		throw new Error(`Ambiguous session match for ${label}`);
	}
	const matchedSession = matched[0];
	if (!matchedSession) {
		throw new Error(`No session found matching ${label}`);
	}
	return matchedSession;
}

async function listResolvableSessions(ctx: ExtensionContext): Promise<SessionInfo[]> {
	const localSessions = await SessionManager.list(
		ctx.sessionManager.getCwd(),
		ctx.sessionManager.getSessionDir(),
		undefined,
		ctx.controlDbPath,
	);
	const allSessions = await SessionManager.listAll(undefined, undefined, ctx.controlDbPath);
	return [...new Map([...localSessions, ...allSessions].map((session) => [session.path, session])).values()];
}

async function resolveResumeSessionFile(params: ResumeSessionParams, ctx: ExtensionContext): Promise<string> {
	if (params.path) {
		return assertResumeSessionPath(resolvePath(params.path, ctx.cwd));
	}

	const sessions = await listResolvableSessions(ctx);
	if (params.name) {
		return findUniqueSessionMatch(sessions, `name '${params.name}'`, (session) => session.name === params.name).path;
	}

	if (!params.id) {
		throw new Error("pi.sessions.resume requires { path }, { id }, or { name }");
	}
	const id = params.id;
	const exactMatches = sessions.filter((session) => session.id === id);
	const exactMatch = exactMatches[0];
	if (exactMatches.length === 1 && exactMatch) return exactMatch.path;
	if (exactMatches.length > 1) throw new Error(`Ambiguous session match for id '${id}'`);
	return findUniqueSessionMatch(sessions, `id '${id}'`, (session) => session.id.startsWith(id)).path;
}

function createPyrunExecutorState(
	ctx: ExtensionContext,
	dispatchPiRequest: PyrunPiRequestDispatcher,
	bwrapCommand: string,
): PyrunExecutorState {
	const profile = resolveBwrapSandboxProfile(ctx.settingsManager?.getExplicitSandboxProfile() ?? "full-access");
	const key = `${profile ?? "full-access"}\0${ctx.cwd}`;
	if (!profile) {
		const runnerOptions = resolvePyrunRunnerOptions();
		const runner = new PyrunRunnerClient(runnerOptions);
		return {
			evaluate: createPyrunEvalExecutor(runner, dispatchPiRequest),
			key,
			piBridgeEnabled: true,
			runner,
			runnerOptions,
		};
	}

	const resolvedRunner = resolvePyrunRunnerOptions();
	const wrappedRunner = createBwrapRunnerCommand({
		bwrapCommand,
		cwd: ctx.cwd,
		profile,
		runnerArgs: resolvedRunner.args,
		runnerCommand: resolvedRunner.command,
		runnerEnv: createBwrapRunnerEnvironment(process.env, resolvedRunner.env.PYTHONPATH),
	});
	const runnerOptions = { ...wrappedRunner, inheritEnv: false };
	const runner = new PyrunRunnerClient(runnerOptions);
	return {
		evaluate: createPyrunEvalExecutor(runner, undefined, { enablePiBridge: false }),
		key,
		piBridgeEnabled: false,
		runner,
		runnerOptions,
	};
}

export function createPyrunPiDispatcher(pi: ExtensionAPI, options: PyrunExtensionOptions): PyrunPiRequestDispatcher {
	return async (request, ctx, signal) => {
		const builtIn = await dispatchBuiltinPyrunRequest(request, pi, ctx, signal);
		if (builtIn.handled) return builtIn.result;
		for (const handler of options.piRequestHandlers ?? []) {
			const result = await handler(request, ctx, signal);
			if (result !== undefined) return result;
		}
		throw new Error(`Pi capability is unavailable: ${request.method}`);
	};
}

type BuiltinPyrunRequestResult = { handled: false } | { handled: true; result: unknown };

async function dispatchBuiltinPyrunRequest(
	request: { method: string; params: unknown },
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<BuiltinPyrunRequestResult> {
	switch (request.method) {
		case "models.scoped":
			return { handled: true, result: listScopedModels(ctx) };
		case "models.set":
			return { handled: true, result: await setSessionModel(request.params, pi, ctx) };
		case "tools.call":
			return { handled: true, result: await callActiveTool(request.params, pi, signal) };
		case "commands.list":
			return { handled: true, result: pi.getCommands() };
		case "commands.run":
			return { handled: true, result: await callCommand(request.params, pi) };
		case "compact":
			return { handled: true, result: triggerCompact(request.params, ctx) };
		case "messages.enqueue":
			return { handled: true, result: enqueueMessage(request.params, pi) };
		case "restart":
			return { handled: true, result: await triggerRestart(request.params, ctx) };
		case "sessions.resume":
			return { handled: true, result: await triggerSessionResume(request.params, ctx) };
		default:
			return { handled: false };
	}
}

function listScopedModels(ctx: ExtensionContext): Array<{
	id: string;
	name?: string;
	provider: string;
	thinkingLevel?: string;
}> {
	return (ctx.getScopedModels?.() ?? []).map((scoped) => ({
		id: scoped.model.id,
		...(scoped.model.name ? { name: scoped.model.name } : {}),
		provider: scoped.model.provider,
		...(scoped.thinkingLevel ? { thinkingLevel: scoped.thinkingLevel } : {}),
	}));
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type PyrunThinkingLevel = (typeof THINKING_LEVELS)[number];

function isPyrunThinkingLevel(value: string): value is PyrunThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

async function setSessionModel(
	params: unknown,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<{ model: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>>[number]; thinkingLevel?: string }> {
	const request = normalizeSetModelParams(params);
	const model = ctx.modelRegistry
		.getAvailable()
		.find((candidate) => candidate.provider === request.provider && candidate.id === request.id);
	if (!model) {
		throw new Error(`Model not found or not authenticated: ${request.provider}/${request.id}`);
	}
	if (!(await pi.setModel(model))) {
		throw new Error(`No API key for ${request.provider}/${request.id}`);
	}
	if (request.thinkingLevel) {
		pi.setThinkingLevel(request.thinkingLevel);
	}
	return { model, ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}) };
}

function normalizeSetModelParams(params: unknown): {
	id: string;
	provider: string;
	thinkingLevel?: PyrunThinkingLevel;
} {
	if (!params || typeof params !== "object") {
		throw new Error("pi.models.set requires { provider, id, thinkingLevel? }");
	}
	const record = params as { id?: unknown; provider?: unknown; thinkingLevel?: unknown };
	if (typeof record.provider !== "string" || record.provider.trim() === "") {
		throw new Error("pi.models.set requires a non-empty provider");
	}
	if (typeof record.id !== "string" || record.id.trim() === "") {
		throw new Error("pi.models.set requires a non-empty id");
	}
	if (
		record.thinkingLevel !== undefined &&
		(typeof record.thinkingLevel !== "string" || !isPyrunThinkingLevel(record.thinkingLevel))
	) {
		throw new Error("pi.models.set thinkingLevel must be off, minimal, low, medium, high, or xhigh");
	}
	return {
		provider: record.provider.trim(),
		id: record.id.trim(),
		...(record.thinkingLevel ? { thinkingLevel: record.thinkingLevel } : {}),
	};
}

async function callActiveTool(params: unknown, pi: ExtensionAPI, signal: AbortSignal | undefined): Promise<unknown> {
	const request = normalizeToolCallParams(params);
	return pi.callTool(request.name, request.params, signal);
}

function normalizeToolCallParams(params: unknown): { name: string; params: unknown } {
	if (!params || typeof params !== "object") {
		throw new Error("pi.tools.call requires { name, params }");
	}
	const record = params as { name?: unknown; params?: unknown; toolName?: unknown };
	const name = record.name ?? record.toolName;
	if (typeof name !== "string" || name.trim() === "") {
		throw new Error("pi.tools.call requires a non-empty tool name");
	}
	return { name: name.trim(), params: record.params };
}

async function callCommand(params: unknown, pi: ExtensionAPI): Promise<unknown> {
	const request = normalizeCommandRunParams(params);
	return pi.callCommand(request.name, request.args);
}

function normalizeCommandRunParams(params: unknown): { args: string; name: string } {
	if (!params || typeof params !== "object") {
		throw new Error("pi.commands.run requires { name, args }");
	}
	const record = params as { args?: unknown; name?: unknown };
	if (typeof record.name !== "string" || record.name.trim() === "") {
		throw new Error("pi.commands.run requires a non-empty command name");
	}
	if (record.args !== undefined && typeof record.args !== "string") {
		throw new Error("pi.commands.run args must be a string when provided");
	}
	return { name: record.name.trim(), args: record.args ?? "" };
}

function triggerCompact(params: unknown, ctx: ExtensionContext): { started: true } {
	ctx.compact(normalizeCompactParams(params));
	return { started: true };
}

async function triggerRestart(params: unknown, ctx: ExtensionContext): Promise<{ started: true }> {
	await ctx.restart(normalizeRestartParams(params));
	return { started: true };
}

async function triggerSessionResume(params: unknown, ctx: ExtensionContext): Promise<{ cancelled: boolean; resumed: boolean }> {
	if (!ctx.switchSession) {
		throw new Error("pi.sessions.resume is not available in this session mode");
	}
	const resumeParams = normalizeResumeSessionParams(params);
	const sessionFile = await resolveResumeSessionFile(resumeParams, ctx);
	const result = await ctx.switchSession(sessionFile);
	return { cancelled: result.cancelled, resumed: !result.cancelled };
}

function enqueueMessage(params: unknown, pi: ExtensionAPI): { enqueued: true } {
	const message = normalizeMessageParams(params);
	pi.sendUserMessage(message.message, { deliverAs: message.deliverAs });
	return { enqueued: true };
}

function normalizeMessageParams(params: unknown): { deliverAs?: "steer" | "followUp"; message: string } {
	if (typeof params === "string") {
		return { message: params };
	}
	if (!params || typeof params !== "object") {
		throw new Error("pi.messages.enqueue requires a message string or { message } object");
	}
	const record = params as { deliverAs?: unknown; message?: unknown };
	if (typeof record.message !== "string") {
		throw new Error("pi.messages.enqueue requires a string message");
	}
	const deliverAs = record.deliverAs === "steer" || record.deliverAs === "followUp" ? record.deliverAs : undefined;
	return { deliverAs, message: record.message };
}

export type PyrunToolEvaluator = (
	toolCallId: string,
	params: PyrunEvalParams,
	ctx: ExtensionContext,
	onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
	signal: AbortSignal | undefined,
) => Promise<AgentToolResult<unknown>>;

export interface PyrunToolDefinitionOptions {
	promptGuidelines?: string[];
	promptSnippet?: string;
}

export function createPyrunToolDefinition(
	evaluate: PyrunToolEvaluator,
	options: PyrunToolDefinitionOptions = {},
): ToolDefinition<typeof pyrunEvalSchema, unknown> {
	return {
		name: "pyrun_eval",
		label: "Pyrun Eval",
		description: "Evaluate Python/Pyrun code through the canonical Pyrun JSONL runtime adapter.",
		promptSnippet: options.promptSnippet ?? PYRUN_PROMPT_SNIPPET,
		promptGuidelines: options.promptGuidelines ?? PYRUN_PROMPT_GUIDELINES,
		approvalRequired: true,
		parameters: pyrunEvalSchema,
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const sessionId = readStringArg(args, "session_id");
			const label = sessionId && sessionId !== "default" ? `pyrun_eval(${sessionId})` : "pyrun_eval";
			const code = readStringArg(args, "code");
			const highlightedCode = code ? highlightCode(code, "python").join("\n") : undefined;
			text.setText(highlightedCode ? `${theme.bold(label)}\n${highlightedCode}` : theme.bold(label));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text ?? "")
				.join("\n");
			const executed = getExecutedCode(result.details) ?? readStringArg(context.args, "code");
			text.setText(formatPyrunResult(output, executed, context.isError, theme));
			return text;
		},
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const pyrunParams = params as PyrunEvalParams;
			return evaluate(toolCallId, pyrunParams, ctx, onUpdate, signal);
		},
	};
}

async function handleDetachedPyrunBridgeRequest(
	event: RuntimeMailboxEvent,
	ctx: ExtensionContext,
	dispatchPiRequest: PyrunPiRequestDispatcher,
): Promise<{ handled: boolean }> {
	const request = parseDetachedPyrunBridgeRequest(event.message);
	if (!request) return { handled: false };
	const controlDbPath = ctx.controlDbPath;
	if (!controlDbPath) throw new Error("Detached Pyrun bridge requires the control database");
	const sessionPath = event.message.storeRef.sessionPath;
	const supervisorSessionId = ctx.sessionManager.getSessionId();
	if (
		!validateDetachedPyrunBridgeRequest({
			controlDbPath,
			message: event.message,
			nowIso: new Date().toISOString(),
			request,
			sessionPath,
			supervisorSessionId,
		})
	) {
		throw new Error(`Detached Pyrun bridge request is stale or foreign: ${request.requestId}`);
	}
	await respondToDetachedPyrunBridgeRequest({
		controlDbPath,
		ctx,
		dispatchPiRequest,
		request,
		sessionPath,
		supervisorAddress: event.message.recipient,
	});
	return { handled: true };
}

async function respondToDetachedPyrunBridgeRequest(input: {
	controlDbPath: string;
	ctx: ExtensionContext;
	dispatchPiRequest: PyrunPiRequestDispatcher;
	request: NonNullable<ReturnType<typeof parseDetachedPyrunBridgeRequest>>;
	sessionPath: string;
	supervisorAddress: RuntimeMailboxEvent["message"]["recipient"];
}): Promise<void> {
	try {
		const result = await input.dispatchPiRequest(
			{ method: input.request.method, params: input.request.params },
			input.ctx,
			input.ctx.signal,
		);
		enqueueDetachedPyrunBridgeResponse({ ...input, result });
	} catch (error) {
		enqueueDetachedPyrunBridgeResponse({
			...input,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export default function pyrunExtension(pi: ExtensionAPI, options: PyrunExtensionOptions = {}) {
	const dispatchPiRequest = createPyrunPiDispatcher(pi, options);
	pi.on("runtime_mailbox", (event, ctx) => handleDetachedPyrunBridgeRequest(event, ctx, dispatchPiRequest));
	const bwrapCommand = options.bwrapCommand ?? process.env.PI_BWRAP_COMMAND ?? "bwrap";
	let executorState: PyrunExecutorState | undefined;
	const executorFor = (ctx: ExtensionContext): PyrunExecutorState => {
		const profile = resolveBwrapSandboxProfile(ctx.settingsManager?.getExplicitSandboxProfile() ?? "full-access");
		const key = `${profile ?? "full-access"}\0${ctx.cwd}`;
		if (executorState?.key === key) return executorState;
		executorState?.runner.dispose();
		executorState = createPyrunExecutorState(ctx, dispatchPiRequest, bwrapCommand);
		return executorState;
	};
	pi.on("session_shutdown", () => {
		executorState?.runner.dispose();
		executorState = undefined;
		for (const handler of options.piRequestHandlers ?? []) handler.dispose?.();
	});

	pi.registerTool(
		createPyrunToolDefinition(async (toolCallId, params, ctx, onUpdate, signal) => {
			const store = options.backgroundJobs?.store ?? ctx.multiAgentStore;
			const detachRegistry = options.detachRegistry ?? ctx.toolDetachRegistry;
			const activeExecutor = executorFor(ctx);
			const typedOnUpdate = onUpdate as
				| ((partialResult: AgentToolResult<CanonicalPyrunEvalResult | CanonicalPyrunProgressUpdate>) => void)
				| undefined;
			if (!store || !detachRegistry) {
				return activeExecutor.evaluate(params, ctx, typedOnUpdate, signal);
			}
			return runDurableDetachablePyrunEvaluation({
				ctx,
				toolCallId,
				detachRegistry,
				dispatchPiRequest,
				onUpdate: typedOnUpdate,
				params,
				piBridgeEnabled: activeExecutor.piBridgeEnabled,
				runnerOptions: activeExecutor.runnerOptions,
				signal,
				store,
			});
		}),
	);
}
