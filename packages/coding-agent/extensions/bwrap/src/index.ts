import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../../../src/index.ts";
import type { TSchema } from "typebox";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	formatSize,
	truncateHead,
	type EditOperations,
	type FindOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type LsOperations,
	type ReadOperations,
	type WriteOperations,
} from "../../../src/index.ts";
import type { SandboxProfileName } from "../../../src/core/permissions/presets.ts";
import {
	runBwrapAvailabilityCheck,
	buildBwrapInvocation,
	createSandboxedBashOperations,
	resolveBwrapSandboxProfile,
	type BwrapSandboxProfile,
} from "./backend.ts";

interface BwrapExtensionOptions {
	bwrapCommand?: string;
}

interface JsonCommandResult<T> {
	stderr: string;
	stdout: string;
	value: T;
}

interface FileStatResult {
	isDirectory: boolean;
	size: number;
}

interface GrepResult {
	details?: GrepToolDetails;
	text: string;
}

interface SandboxParams {
	bwrapCommand: string;
	cwd: string;
	profile: BwrapSandboxProfile;
}

interface SandboxWorkerOutput {
	stderr: string;
	stdout: string;
}

type LocalToolDefinitions = {
	read: ReturnType<typeof createReadToolDefinition>;
	write: ReturnType<typeof createWriteToolDefinition>;
	edit: ReturnType<typeof createEditToolDefinition>;
	bash: ReturnType<typeof createBashToolDefinition>;
	grep: ReturnType<typeof createGrepToolDefinition>;
	find: ReturnType<typeof createFindToolDefinition>;
	ls: ReturnType<typeof createLsToolDefinition>;
};

interface BwrapExtensionRuntime {
	bwrapCommand: string;
	localTools: LocalToolDefinitions;
}

const DEFAULT_BWRAP_COMMAND = process.env.PI_BWRAP_COMMAND ?? "bwrap";
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_MAX_BYTES = 10 * 1024;
const SOURCE_FS_WORKER_PATH = `${dirname(fileURLToPath(import.meta.url))}/fs-worker.cjs`;
const FS_WORKER_PATH = findFsWorkerPath();

function findFsWorkerPath(): string {
	if (existsSync(SOURCE_FS_WORKER_PATH)) {
		return SOURCE_FS_WORKER_PATH;
	}
	return join(dirname(process.execPath), "fs-worker.cjs");
}

function readSandboxProfileName(ctx: ExtensionContext): SandboxProfileName {
	return ctx.settingsManager?.getExplicitSandboxProfile() ?? "full-access";
}

function readSandboxProfile(ctx: ExtensionContext): BwrapSandboxProfile | undefined {
	return resolveBwrapSandboxProfile(readSandboxProfileName(ctx));
}

function readSandboxParams(ctx: ExtensionContext, bwrapCommand: string): SandboxParams | undefined {
	const profile = readSandboxProfile(ctx);
	return profile ? { bwrapCommand, cwd: ctx.cwd, profile } : undefined;
}

interface SandboxOperationParams extends SandboxParams {
	operation: string;
	payload: Record<string, unknown>;
	signal?: AbortSignal;
}

function buildSandboxWorkerInvocation(params: SandboxOperationParams) {
	const workerPayload = { ...params.payload, workspace: params.cwd };
	return buildBwrapInvocation({
		bwrapCommand: params.bwrapCommand,
		command: ["node", FS_WORKER_PATH, params.operation, JSON.stringify(workerPayload)],
		cwd: params.cwd,
		extraReadOnlyPaths: [dirname(FS_WORKER_PATH)],
		profile: params.profile,
	});
}

async function runJsonInSandbox<T>(params: SandboxOperationParams): Promise<JsonCommandResult<T>> {
	runBwrapAvailabilityCheck(params.bwrapCommand);
	const invocation = buildSandboxWorkerInvocation(params);
	return spawnSandboxWorker<T>(invocation, params.signal);
}

function spawnSandboxWorker<T>(
	invocation: ReturnType<typeof buildBwrapInvocation>,
	signal: AbortSignal | undefined,
): Promise<JsonCommandResult<T>> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(invocation.command, invocation.argv, {
			env: invocation.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const output: SandboxWorkerOutput = { stderr: "", stdout: "" };
		attachSandboxOutput(child, output);
		const onAbort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", reject);
		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			try {
				resolvePromise(parseSandboxWorkerResult<T>(code, output, signal));
			} catch (error) {
				reject(error);
			}
		});
	});
}

function attachSandboxOutput(child: { stdout: Readable; stderr: Readable }, output: SandboxWorkerOutput): void {
	child.stdout.on("data", (chunk: Buffer) => {
		output.stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		output.stderr += chunk.toString("utf8");
	});
}

function parseSandboxWorkerResult<T>(
	code: number | null,
	output: SandboxWorkerOutput,
	signal: AbortSignal | undefined,
): JsonCommandResult<T> {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
	if (code !== 0) {
		throw new Error(output.stderr.trim() || `sandbox operation failed with exit code ${code}`);
	}
	try {
		return { stderr: output.stderr, stdout: output.stdout, value: JSON.parse(output.stdout) as T };
	} catch (error) {
		throw error instanceof Error ? error : new Error(String(error));
	}
}

type SandboxOperationRunner = <T>(operation: string, payload: Record<string, unknown>) => Promise<T>;

function createSandboxOperationRunner(params: SandboxParams): SandboxOperationRunner {
	return <T>(operation: string, payload: Record<string, unknown>) =>
		runJsonInSandbox<T>({ ...params, operation, payload }).then(({ value }) => value);
}

function createReadOperations(params: SandboxParams): ReadOperations {
	const runSandboxOperation = createSandboxOperationRunner(params);
	return {
		access: async (path) => {
			await runSandboxOperation<{ ok: true }>("access", { path });
		},
		detectImageMimeType: async (path) => mimeTypeForPath(path),
		readFile: async (path) =>
			Buffer.from((await runSandboxOperation<{ data: string }>("readFile", { path })).data, "base64"),
		readRange: async (path, start, end) =>
			Buffer.from((await runSandboxOperation<{ data: string }>("readRange", { end, path, start })).data, "base64"),
		stat: async (path) => ({ size: (await runSandboxOperation<FileStatResult>("stat", { path })).size }),
	};
}

function createWriteOperations(params: SandboxParams): WriteOperations {
	const runSandboxOperation = createSandboxOperationRunner(params);
	return {
		mkdir: async (path) => {
			await runSandboxOperation<{ ok: true }>("mkdir", { path });
		},
		writeFile: async (path, content) => {
			await runSandboxOperation<{ ok: true }>("writeFile", { content, path });
		},
	};
}

function createEditOperations(params: SandboxParams): EditOperations {
	const readOps = createReadOperations(params);
	const writeOps = createWriteOperations(params);
	return {
		access: readOps.access,
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
	};
}

function createLsOperations(params: SandboxParams): LsOperations {
	const runSandboxOperation = createSandboxOperationRunner(params);
	return {
		exists: async (path) => (await runSandboxOperation<{ exists: boolean }>("exists", { path })).exists,
		readdir: async (path) => (await runSandboxOperation<{ entries: string[] }>("readdir", { path })).entries,
		stat: async (path) => {
			const stat = await runSandboxOperation<FileStatResult>("stat", { path });
			return { isDirectory: () => stat.isDirectory };
		},
	};
}

function createFindOperations(params: SandboxParams): FindOperations {
	const runSandboxOperation = createSandboxOperationRunner(params);
	return {
		exists: async (path) => (await runSandboxOperation<{ exists: boolean }>("exists", { path })).exists,
		glob: async (pattern, cwd, options) =>
			(await runSandboxOperation<{ results: string[] }>("find", { cwd, limit: options.limit, pattern })).results,
	};
}

function mimeTypeForPath(path: string): string | null {
	const ext = extname(path).toLowerCase();
	if (ext === ".png") return "image/png";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".gif") return "image/gif";
	if (ext === ".webp") return "image/webp";
	return null;
}

function buildGrepNotices(
	details: GrepToolDetails,
	truncation: ReturnType<typeof truncateHead>,
): string[] {
	return [
		...(details.matchLimitReached ? [`${details.matchLimitReached} matches limit reached`] : []),
		...(details.linesTruncated ? ["long lines truncated"] : []),
		...(truncation.truncated ? [`${formatSize(DEFAULT_MAX_BYTES)} limit reached`] : []),
	];
}

function buildGrepDetails(
	details: GrepToolDetails,
	truncation: ReturnType<typeof truncateHead>,
): GrepToolDetails {
	return truncation.truncated ? { ...details, truncation } : details;
}

async function executeSandboxedGrep(
	params: SandboxParams,
	input: GrepToolInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GrepToolDetails | undefined>> {
	const searchPath = input.path ?? ".";
	const result = await runJsonInSandbox<GrepResult>({
		...params,
		operation: "grep",
		payload: {
			context: input.context,
			glob: input.glob,
			ignoreCase: input.ignoreCase,
			limit: input.limit ?? DEFAULT_GREP_LIMIT,
			literal: input.literal,
			path: searchPath,
			pattern: input.pattern,
		},
		signal,
	});
	const truncation = truncateHead(result.value.text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: Number.MAX_SAFE_INTEGER });
	const details = buildGrepDetails(result.value.details ?? {}, truncation);
	const notices = buildGrepNotices(details, truncation);
	const text = notices.length > 0 ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
	return { content: [{ type: "text", text }], details: Object.keys(details).length > 0 ? details : undefined };
}

function createBwrapExtensionRuntime(options: BwrapExtensionOptions, localCwd: string): BwrapExtensionRuntime {
	return {
		bwrapCommand: options.bwrapCommand ?? DEFAULT_BWRAP_COMMAND,
		localTools: {
			bash: createBashToolDefinition(localCwd),
			edit: createEditToolDefinition(localCwd),
			find: createFindToolDefinition(localCwd),
			grep: createGrepToolDefinition(localCwd),
			ls: createLsToolDefinition(localCwd),
			read: createReadToolDefinition(localCwd),
			write: createWriteToolDefinition(localCwd),
		},
	};
}

function registerBwrapSessionStart(pi: ExtensionAPI, runtime: BwrapExtensionRuntime): void {
	pi.on("session_start", async (_event, ctx) => {
		const profile = readSandboxProfile(ctx);
		if (!profile) {
			ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("muted", "bwrap: full access"));
			return;
		}
		try {
			runBwrapAvailabilityCheck(runtime.bwrapCommand);
			ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("accent", `bwrap: ${profile}`));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("error", "bwrap unavailable"));
			ctx.ui.notify(message, "error");
		}
	});
}

function registerBwrapToolGate(pi: ExtensionAPI, runtime: BwrapExtensionRuntime): void {
	pi.registerToolGate((_event, ctx) => {
		if (!readSandboxProfile(ctx)) return;
		try {
			runBwrapAvailabilityCheck(runtime.bwrapCommand);
			return;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { block: true, reason };
		}
	});
}

function registerSandboxedTool<TParams extends TSchema, TDetails, TState>(
	pi: ExtensionAPI,
	runtime: BwrapExtensionRuntime,
	localTool: ToolDefinition<TParams, TDetails, TState>,
	createSandboxedTool: (cwd: string, params: SandboxParams) => ToolDefinition<TParams, TDetails, TState>,
): void {
	pi.registerTool({
		...localTool,
		async execute(id, params, signal, onUpdate, ctx) {
			const sandbox = readSandboxParams(ctx, runtime.bwrapCommand);
			if (!sandbox) return localTool.execute(id, params, signal, onUpdate, ctx);
			return createSandboxedTool(ctx.cwd, sandbox).execute(id, params, signal, onUpdate, ctx);
		},
	});
}

function registerStandardSandboxedTools(pi: ExtensionAPI, runtime: BwrapExtensionRuntime): void {
	registerSandboxedTool(pi, runtime, runtime.localTools.read, (cwd, params) =>
		createReadToolDefinition(cwd, { operations: createReadOperations(params) }),
	);
	registerSandboxedTool(pi, runtime, runtime.localTools.write, (cwd, params) =>
		createWriteToolDefinition(cwd, { operations: createWriteOperations(params) }),
	);
	registerSandboxedTool(pi, runtime, runtime.localTools.edit, (cwd, params) =>
		createEditToolDefinition(cwd, { operations: createEditOperations(params) }),
	);
	registerSandboxedTool(pi, runtime, runtime.localTools.ls, (cwd, params) =>
		createLsToolDefinition(cwd, { operations: createLsOperations(params) }),
	);
	registerSandboxedTool(pi, runtime, runtime.localTools.find, (cwd, params) =>
		createFindToolDefinition(cwd, { operations: createFindOperations(params) }),
	);
}

function registerSandboxedBashTool(pi: ExtensionAPI, runtime: BwrapExtensionRuntime): void {
	const localBash = runtime.localTools.bash;
	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			const sandbox = readSandboxParams(ctx, runtime.bwrapCommand);
			if (!sandbox) {
				const store = ctx.multiAgentStore;
				return createBashToolDefinition(ctx.cwd, {
					backgroundJobs: store ? { lifecycle: ctx.detachedJobLifecycle, store } : undefined,
					detachRegistry: ctx.toolDetachRegistry,
				}).execute(id, params, signal, onUpdate, ctx);
			}
			return createBashToolDefinition(ctx.cwd, {
				operations: createSandboxedBashOperations({
					bwrapCommand: runtime.bwrapCommand,
					profile: sandbox.profile,
				}),
			}).execute(id, params, signal, onUpdate, ctx);
		},
	});
}

function registerSandboxedGrepTool(pi: ExtensionAPI, runtime: BwrapExtensionRuntime): void {
	const localGrep = runtime.localTools.grep;
	pi.registerTool({
		...localGrep,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const sandbox = readSandboxParams(ctx, runtime.bwrapCommand);
			if (!sandbox) return localGrep.execute("grep", params, signal, _onUpdate, ctx);
			return executeSandboxedGrep(sandbox, params, signal);
		},
	});
}

function registerBwrapTools(pi: ExtensionAPI, runtime: BwrapExtensionRuntime): void {
	registerStandardSandboxedTools(pi, runtime);
	registerSandboxedBashTool(pi, runtime);
	registerSandboxedGrepTool(pi, runtime);
}

function registerUserBashHandler(pi: ExtensionAPI, runtime: BwrapExtensionRuntime): void {
	pi.on("user_bash", async (_event, ctx) => {
		const profile = readSandboxProfile(ctx);
		return { operations: createSandboxedBashOperations({ bwrapCommand: runtime.bwrapCommand, profile }) };
	});
}

function registerBeforeAgentStartHandler(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const profile = readSandboxProfile(ctx);
		if (!profile) return;
		const localLine = `Current working directory: ${ctx.cwd}`;
		const sandboxLine = `Current working directory: ${ctx.cwd} (Linux bubblewrap sandbox, profile ${profile}; HOME is fake, only runtime paths plus workspace are mounted, and Pyrun executes inside the sandbox without Pi bridge capabilities)`;
		const systemPrompt = event.systemPrompt.includes(localLine)
			? event.systemPrompt.replace(localLine, sandboxLine)
			: `${event.systemPrompt}\n\n${sandboxLine}`;
		return { systemPrompt };
	});
}

function registerBwrapStatusCommand(pi: ExtensionAPI, runtime: BwrapExtensionRuntime): void {
	pi.registerCommand("bwrap", {
		description: "Show bubblewrap sandbox status",
		handler: async (_args, ctx) => {
			const profile = readSandboxProfile(ctx);
			const mode = profile ? `sandboxed (${profile})` : "unsandboxed/full-access";
			ctx.ui.notify(
				[`bwrap backend: ${mode}`, `cwd: ${ctx.cwd}`, `bwrap: ${runtime.bwrapCommand}`].join("\n"),
				"info",
			);
		},
	});
}

export default function bwrapExtension(pi: ExtensionAPI, options: BwrapExtensionOptions = {}): void {
	const localCwd = process.cwd();
	const runtime = createBwrapExtensionRuntime(options, localCwd);
	registerBwrapSessionStart(pi, runtime);
	registerBwrapToolGate(pi, runtime);
	registerBwrapTools(pi, runtime);
	registerUserBashHandler(pi, runtime);
	registerBeforeAgentStartHandler(pi);
	registerBwrapStatusCommand(pi, runtime);
}
