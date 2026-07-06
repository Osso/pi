import { randomUUID } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type SessionInfo, SessionManager } from "../../../src/core/session-manager.ts";
import { highlightCode, type Theme } from "../../../src/modes/interactive/theme/theme.ts";
import { isActiveLifecycle, type MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import type { ToolDetachRegistry } from "../../../src/core/tool-detach-registry.ts";
import { resolvePath } from "../../../src/utils/paths.ts";
import { createPyrunEvalExecutor, type PyrunEvalParams, type PyrunPiRequestDispatcher } from "./eval-tool.ts";
import { PyrunRunnerClient } from "./runner.ts";

export interface PyrunBackgroundJobsOptions {
	store: MultiAgentStore;
}

export interface PyrunExtensionOptions {
	backgroundJobs?: PyrunBackgroundJobsOptions;
	detachRegistry?: ToolDetachRegistry;
	piRequestHandlers?: PyrunPiRequestDispatcher[];
}

interface PyrunBackgroundJob {
	artifactId: string;
	id: string;
	logPath: string;
}

type PyrunEvaluate = ReturnType<typeof createPyrunEvalExecutor>;

interface PyrunExecutorState {
	evaluate: PyrunEvaluate;
	runner: PyrunRunnerClient;
}

interface DetachablePyrunEvaluationOptions {
	detachRegistry: ToolDetachRegistry;
	evaluate: PyrunEvaluate;
	ctx: ExtensionContext;
	onBackgroundSettled?: () => void;
	onDetached?: () => void;
	onUpdate?: (partialResult: AgentToolResult<unknown>) => void;
	params: PyrunEvalParams;
	signal: AbortSignal | undefined;
	store: MultiAgentStore;
}

interface MirroredAbortController {
	controller: AbortController;
	cleanup: () => void;
}

const PYRUN_PROMPT_SNIPPET = "Evaluate Python through the canonical Pyrun JSONL runtime adapter";

const PYRUN_PROMPT_GUIDELINES = [
	"Pyrun evaluates Python code in a persistent Python session with a persistent ctx object.",
	"Pi delegates Python/Pyrun runtime semantics to the Pyrun JSONL runner; Pi does not implement helper behavior locally.",
	"Do not use MCP for Pi's built-in pyrun_eval path; use the JSONL runner boundary.",
	"Use pi.footer.snapshot() to read the current Pi footer snapshot inside Pyrun.",
	"Use pi.compact(...) to trigger Pi session compaction from Pyrun.",
	"Use pi.restart(...) to restart Pi and resume the same session from Pyrun.",
	"Use pi.sessions.resume({ path | id | name }) to switch Pi to a target session from Pyrun.",
	"Use pi.models.scoped() to list the current session scoped models for model cycling.",
	"Use pi.tools.call(name, params) to call active Pi tools from Pyrun, and pi.web_search(query) as a web_search shortcut.",
	"Use pi.commands.list() to list slash commands and pi.commands.run(name, args=\"\") to run registered slash commands from Pyrun.",
	"Use pi.agents.spawn(...), pi.agents.list(...), pi.agents.wait(...), pi.agents.current(), pi.agents.select(agent_id), pi.messages.last(), pi.messages.enqueue(...), and pi.messages.send(...) for the supported Pi runtime bridge; pi.agents.wait(...) is synchronization-only and returns no agent output.",
	"Use Pyrun helpers directly: host, fs, cli, run, http, rg, fd, sqlite, kubectl, tools, text, seq, obj, and hr.",
	"Use tools.ssh({ host, user, port, password }) for SSH commands that need password auth; it wraps sshpass automatically.",
	"run.* displays only the last 300 output lines by default; access full logs from the returned CommandResult or previous results with run.last().stdout, run.last().stderr, or run.history().",
	"Agents MUST NOT rerun the same command only to recover logs; inspect the saved CommandResult/full logs instead.",
	"Do not compose shell strings for Pyrun command helpers; call argv-style helpers instead.",
];

function formatPyrunDisplay(text: string, executed: string | undefined, isError: boolean, theme: Theme): string {
	if (!executed) {
		return theme.fg("toolOutput", text);
	}

	const highlightedCode = highlightCode(executed, "python").join("\n");
	if (!text.startsWith(executed)) {
		const prefix = isError && !text.startsWith("Error:") ? "Error: " : "";
		return `${highlightedCode}\n\n${theme.fg("toolOutput", `${prefix}${text}`)}`;
	}

	const rest = text.slice(executed.length).replace(/^\n+/, "");
	return rest ? `${highlightedCode}\n\n${theme.fg("toolOutput", rest)}` : highlightedCode;
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

function textFromToolResult(result: AgentToolResult<unknown>): string {
	return result.content.map((item) => (item.type === "text" ? (item.text ?? "") : "")).join("\n");
}

function createPyrunLogPath(): string {
	return join(tmpdir(), `pi-pyrun-${randomUUID()}.log`);
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

function createPyrunExecutorState(dispatchPiRequest: PyrunPiRequestDispatcher): PyrunExecutorState {
	const runner = new PyrunRunnerClient();
	return { evaluate: createPyrunEvalExecutor(runner, dispatchPiRequest), runner };
}

function createPyrunPiDispatcher(pi: ExtensionAPI, options: PyrunExtensionOptions): PyrunPiRequestDispatcher {
	return async (request, ctx, signal) => {
		if (request.method === "models.scoped") return listScopedModels(ctx);
		if (request.method === "tools.call") return callActiveTool(request.params, pi, signal);
		if (request.method === "commands.list") return pi.getCommands();
		if (request.method === "commands.run") return callCommand(request.params, pi);
		if (request.method === "compact") return triggerCompact(request.params, ctx);
		if (request.method === "messages.enqueue") return enqueueMessage(request.params, pi);
		if (request.method === "restart") return triggerRestart(request.params, ctx);
		if (request.method === "sessions.resume") return triggerSessionResume(request.params, ctx);
		for (const handler of options.piRequestHandlers ?? []) {
			const result = await handler(request, ctx, signal);
			if (result !== undefined) return result;
		}
		throw new Error(`Pi capability is unavailable: ${request.method}`);
	};
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

function createPyrunPlaceholderLog(params: PyrunEvalParams, logPath: string): void {
	writeFileSync(
		logPath,
		`${params.code}\n\nPyrun evaluation is still running. Final output will replace this file when the background job completes.\n`,
		"utf8",
	);
}

function spawnPyrunBackgroundJob(store: MultiAgentStore, params: PyrunEvalParams, ctx: ExtensionContext): PyrunBackgroundJob {
	const logPath = createPyrunLogPath();
	createPyrunPlaceholderLog(params, logPath);
	const spawned = store.spawnAgent({
		agentType: "background",
		cwd: ctx.cwd,
		displayName: "Pyrun evaluation",
		lifecycle: "starting",
		permission: { narrowed: true, policy: "on-request" },
	});
	const running = store.transitionAgent(spawned.agent.id, spawned.agent.revision, "running", {
		lastActivity: { description: params.code, toolName: "pyrun_eval" },
	});
	const agent = running.ok ? running.agent : spawned.agent;
	const artifact = store.recordArtifact({ agentId: agent.id, kind: "log", path: logPath, title: "Pyrun output" });
	return {
		artifactId: artifact.id,
		id: agent.id,
		logPath,
	};
}

function updatePyrunLogArtifact(job: PyrunBackgroundJob, output: string): string {
	writeFileSync(job.logPath, output, "utf8");
	return job.artifactId;
}

function transitionPyrunJobFailure(store: MultiAgentStore, job: PyrunBackgroundJob, message: string): void {
	const current = store.getAgent(job.id);
	if (!current || !isActiveLifecycle(current.lifecycle)) return;
	store.transitionAgent(current.id, current.revision, "failed", { error: { message } });
}

function finishPyrunBackgroundJob(store: MultiAgentStore, job: PyrunBackgroundJob, result: AgentToolResult<unknown>): void {
	let artifactId: string;
	try {
		artifactId = updatePyrunLogArtifact(job, textFromToolResult(result));
	} catch (error) {
		transitionPyrunJobFailure(store, job, error instanceof Error ? error.message : String(error));
		return;
	}

	const current = store.getAgent(job.id);
	if (!current || !isActiveLifecycle(current.lifecycle)) return;
	const lifecycle = result.isError ? "failed" : "completed";
	const summary = result.isError ? "Pyrun evaluation failed." : "Pyrun evaluation completed.";
	store.transitionAgent(current.id, current.revision, lifecycle, {
		result: { artifactIds: [artifactId], summary },
	});
}

function failPyrunBackgroundJob(store: MultiAgentStore, job: PyrunBackgroundJob, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	try {
		updatePyrunLogArtifact(job, message);
	} catch (logError) {
		transitionPyrunJobFailure(store, job, logError instanceof Error ? logError.message : String(logError));
		return;
	}
	transitionPyrunJobFailure(store, job, message);
}

function createDetachedPyrunResult(params: PyrunEvalParams, job: PyrunBackgroundJob): AgentToolResult<unknown> {
	return {
		content: [
			{
				type: "text",
				text: `${params.code}\n\nPyrun evaluation moved to background as job ${job.id}. Output will be written to ${job.logPath}.`,
			},
		],
		details: { backgroundJobId: job.id, executed: params.code, type: "completed" },
	};
}

function mirrorAbortSignal(signal: AbortSignal | undefined): MirroredAbortController {
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal?.aborted) {
		controller.abort();
		return { cleanup: () => {}, controller };
	}
	signal?.addEventListener("abort", abort, { once: true });
	return { cleanup: () => signal?.removeEventListener("abort", abort), controller };
}

function runDetachablePyrunEvaluation(options: DetachablePyrunEvaluationOptions): Promise<AgentToolResult<unknown>> {
	const abort = mirrorAbortSignal(options.signal);
	let detached = false;
	let unregisterDetach: (() => void) | undefined;
	let resolveDetached = (_result: AgentToolResult<unknown>) => {};
	const detachedResult = new Promise<AgentToolResult<unknown>>((resolve) => {
		resolveDetached = resolve;
	});
	const evaluation = options
		.evaluate(
			options.params,
			options.ctx,
			(update) => {
				if (!detached) options.onUpdate?.(update);
			},
			abort.controller.signal,
		)
		.finally(() => {
			abort.cleanup();
			unregisterDetach?.();
		});

	unregisterDetach = options.detachRegistry.register({
		detach: () => {
			if (detached || abort.controller.signal.aborted) return false;
			detached = true;
			unregisterDetach?.();
			abort.cleanup();
			options.onDetached?.();
			const job = spawnPyrunBackgroundJob(options.store, options.params, options.ctx);
			void evaluation
				.then(
					(result) => finishPyrunBackgroundJob(options.store, job, result),
					(error) => failPyrunBackgroundJob(options.store, job, error),
				)
				.finally(() => options.onBackgroundSettled?.());
			resolveDetached(createDetachedPyrunResult(options.params, job));
			return true;
		},
	});

	return Promise.race([evaluation, detachedResult]);
}

export default function pyrunExtension(pi: ExtensionAPI, options: PyrunExtensionOptions = {}) {
	const dispatchPiRequest = createPyrunPiDispatcher(pi, options);
	let executor = createPyrunExecutorState(dispatchPiRequest);

	pi.registerTool({
		name: "pyrun_eval",
		label: "Pyrun Eval",
		description: "Evaluate Python/Pyrun code through the canonical Pyrun JSONL runtime adapter.",
		promptSnippet: PYRUN_PROMPT_SNIPPET,
		promptGuidelines: PYRUN_PROMPT_GUIDELINES,
		approvalRequired: true,
		parameters: Type.Object({
			code: Type.String({ description: "Python source to evaluate." }),
			session_id: Type.Optional(Type.String({ description: "Pyrun session id. Defaults to this Pi session." })),
		}),
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const sessionId = readStringArg(args, "session_id");
			const label = sessionId && sessionId !== "default" ? `pyrun_eval(${sessionId})` : "pyrun_eval";
			text.setText(theme.bold(label));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text ?? "")
				.join("\n");
			const executed = getExecutedCode(result.details) ?? readStringArg(context.args, "code");
			text.setText(formatPyrunDisplay(output, executed, context.isError, theme));
			return text;
		},
		execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
			onUpdate?.({
				content: [{ type: "text", text: params.code }],
				details: { executed: params.code, type: "running" },
			});
			const store = options.backgroundJobs?.store ?? ctx.multiAgentStore;
			const detachRegistry = options.detachRegistry ?? ctx.toolDetachRegistry;
			const activeExecutor = executor;
			if (!store || !detachRegistry) {
				return activeExecutor.evaluate(params, ctx, onUpdate, signal);
			}
			return runDetachablePyrunEvaluation({
				detachRegistry,
				evaluate: activeExecutor.evaluate,
				ctx,
				onBackgroundSettled: () => activeExecutor.runner.dispose(),
				onDetached: () => {
					if (executor === activeExecutor) {
						executor = createPyrunExecutorState(dispatchPiRequest);
					}
				},
				onUpdate,
				params,
				signal,
				store,
			});
		},
	});
}
