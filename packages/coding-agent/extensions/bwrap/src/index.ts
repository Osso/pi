import { spawn } from "node:child_process";
import { dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "../../../src/index.ts";
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
	assertBwrapAvailable,
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

const DEFAULT_BWRAP_COMMAND = process.env.PI_BWRAP_COMMAND ?? "bwrap";
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_MAX_BYTES = 10 * 1024;
const FS_WORKER_PATH = `${dirname(fileURLToPath(import.meta.url))}/fs-worker.cjs`;

function getProfile(ctx: ExtensionContext): SandboxProfileName {
	return ctx.settingsManager?.getExplicitSandboxProfile() ?? "full-access";
}

function getSandboxProfile(ctx: ExtensionContext): BwrapSandboxProfile | undefined {
	return resolveBwrapSandboxProfile(getProfile(ctx));
}

async function runJsonInSandbox<T>(params: {
	bwrapCommand: string;
	cwd: string;
	operation: string;
	payload: Record<string, unknown>;
	profile: BwrapSandboxProfile;
	signal?: AbortSignal;
}): Promise<JsonCommandResult<T>> {
	assertBwrapAvailable(params.bwrapCommand);
	const workerPayload = { ...params.payload, workspace: params.cwd };
	const invocation = buildBwrapInvocation({
		bwrapCommand: params.bwrapCommand,
		command: [process.execPath, FS_WORKER_PATH, params.operation, JSON.stringify(workerPayload)],
		cwd: params.cwd,
		extraReadOnlyPaths: [dirname(FS_WORKER_PATH)],
		profile: params.profile,
	});
	return new Promise((resolvePromise, reject) => {
		const child = spawn(invocation.command, invocation.argv, {
			env: invocation.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const onAbort = () => child.kill("SIGKILL");
		params.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => {
			params.signal?.removeEventListener("abort", onAbort);
			if (params.signal?.aborted) {
				reject(new Error("Operation aborted"));
				return;
			}
			if (code !== 0) {
				reject(new Error(stderr.trim() || `sandbox operation failed with exit code ${code}`));
				return;
			}
			try {
				resolvePromise({ stderr, stdout, value: JSON.parse(stdout) as T });
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
}

function createReadOperations(params: { bwrapCommand: string; cwd: string; profile: BwrapSandboxProfile }): ReadOperations {
	const run = <T>(operation: string, payload: Record<string, unknown>) =>
		runJsonInSandbox<T>({ ...params, operation, payload }).then((result) => result.value);
	return {
		access: async (path) => {
			await run<{ ok: true }>("access", { path });
		},
		detectImageMimeType: async (path) => mimeTypeForPath(path),
		readFile: async (path) => Buffer.from((await run<{ data: string }>("readFile", { path })).data, "base64"),
		readRange: async (path, start, end) =>
			Buffer.from((await run<{ data: string }>("readRange", { end, path, start })).data, "base64"),
		stat: async (path) => ({ size: (await run<FileStatResult>("stat", { path })).size }),
	};
}

function createWriteOperations(params: { bwrapCommand: string; cwd: string; profile: BwrapSandboxProfile }): WriteOperations {
	const run = <T>(operation: string, payload: Record<string, unknown>) =>
		runJsonInSandbox<T>({ ...params, operation, payload }).then((result) => result.value);
	return {
		mkdir: async (path) => {
			await run<{ ok: true }>("mkdir", { path });
		},
		writeFile: async (path, content) => {
			await run<{ ok: true }>("writeFile", { content, path });
		},
	};
}

function createEditOperations(params: { bwrapCommand: string; cwd: string; profile: BwrapSandboxProfile }): EditOperations {
	const readOps = createReadOperations(params);
	const writeOps = createWriteOperations(params);
	return {
		access: readOps.access,
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
	};
}

function createLsOperations(params: { bwrapCommand: string; cwd: string; profile: BwrapSandboxProfile }): LsOperations {
	const run = <T>(operation: string, payload: Record<string, unknown>) =>
		runJsonInSandbox<T>({ ...params, operation, payload }).then((result) => result.value);
	return {
		exists: async (path) => (await run<{ exists: boolean }>("exists", { path })).exists,
		readdir: async (path) => (await run<{ entries: string[] }>("readdir", { path })).entries,
		stat: async (path) => {
			const stat = await run<FileStatResult>("stat", { path });
			return { isDirectory: () => stat.isDirectory };
		},
	};
}

function createFindOperations(params: { bwrapCommand: string; cwd: string; profile: BwrapSandboxProfile }): FindOperations {
	const run = <T>(operation: string, payload: Record<string, unknown>) =>
		runJsonInSandbox<T>({ ...params, operation, payload }).then((result) => result.value);
	return {
		exists: async (path) => (await run<{ exists: boolean }>("exists", { path })).exists,
		glob: async (pattern, cwd, options) => (await run<{ results: string[] }>("find", { cwd, limit: options.limit, pattern })).results,
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

async function executeSandboxedGrep(
	params: { bwrapCommand: string; cwd: string; profile: BwrapSandboxProfile },
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
	const details = result.value.details ?? {};
	const notices: string[] = [];
	if (details.matchLimitReached) notices.push(`${details.matchLimitReached} matches limit reached`);
	if (details.linesTruncated) notices.push("long lines truncated");
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	const text = notices.length > 0 ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
	return { content: [{ type: "text", text }], details: Object.keys(details).length > 0 ? details : undefined };
}

export default function bwrapExtension(pi: ExtensionAPI, options: BwrapExtensionOptions = {}) {
	const bwrapCommand = options.bwrapCommand ?? DEFAULT_BWRAP_COMMAND;
	const localCwd = process.cwd();
	const localRead = createReadToolDefinition(localCwd);
	const localWrite = createWriteToolDefinition(localCwd);
	const localEdit = createEditToolDefinition(localCwd);
	const localBash = createBashToolDefinition(localCwd);
	const localGrep = createGrepToolDefinition(localCwd);
	const localFind = createFindToolDefinition(localCwd);
	const localLs = createLsToolDefinition(localCwd);
	function sandboxParams(ctx: ExtensionContext): { bwrapCommand: string; cwd: string; profile: BwrapSandboxProfile } | undefined {
		const profile = getSandboxProfile(ctx);
		return profile ? { bwrapCommand, cwd: ctx.cwd, profile } : undefined;
	}

	pi.on("session_start", async (_event, ctx) => {
		const profile = getSandboxProfile(ctx);
		if (!profile) {
			ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("muted", "bwrap: full access"));
			return;
		}
		try {
			assertBwrapAvailable(bwrapCommand);
			ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("accent", `bwrap: ${profile}`));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.setStatus("bwrap", ctx.ui.theme.fg("error", "bwrap unavailable"));
			ctx.ui.notify(message, "error");
		}
	});

	pi.registerToolGate((_event, ctx) => {
		const profile = getSandboxProfile(ctx);
		if (!profile) return;
		try {
			assertBwrapAvailable(bwrapCommand);
			return;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { block: true, reason };
		}
	});

	pi.registerToolGate((event, ctx) => {
		const profile = getSandboxProfile(ctx);
		if (!profile || event.toolName !== "pyrun_eval") return;
		return {
			block: true,
			reason: `pyrun_eval is disabled while bwrap sandbox profile ${profile} is active`,
		};
	});

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			const sandbox = sandboxParams(ctx);
			if (!sandbox) return localRead.execute(id, params, signal, onUpdate, ctx);
			return createReadToolDefinition(ctx.cwd, { operations: createReadOperations(sandbox) }).execute(
				id,
				params,
				signal,
				onUpdate,
				ctx,
			);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			const sandbox = sandboxParams(ctx);
			if (!sandbox) return localWrite.execute(id, params, signal, onUpdate, ctx);
			return createWriteToolDefinition(ctx.cwd, { operations: createWriteOperations(sandbox) }).execute(
				id,
				params,
				signal,
				onUpdate,
				ctx,
			);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			const sandbox = sandboxParams(ctx);
			if (!sandbox) return localEdit.execute(id, params, signal, onUpdate, ctx);
			return createEditToolDefinition(ctx.cwd, { operations: createEditOperations(sandbox) }).execute(
				id,
				params,
				signal,
				onUpdate,
				ctx,
			);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			const sandbox = sandboxParams(ctx);
			if (!sandbox) return localBash.execute(id, params, signal, onUpdate, ctx);
			return createBashToolDefinition(ctx.cwd, {
				operations: createSandboxedBashOperations({ bwrapCommand, profile: sandbox.profile }),
			}).execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate, ctx) {
			const sandbox = sandboxParams(ctx);
			if (!sandbox) return localLs.execute(id, params, signal, onUpdate, ctx);
			return createLsToolDefinition(ctx.cwd, { operations: createLsOperations(sandbox) }).execute(
				id,
				params,
				signal,
				onUpdate,
				ctx,
			);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate, ctx) {
			const sandbox = sandboxParams(ctx);
			if (!sandbox) return localFind.execute(id, params, signal, onUpdate, ctx);
			return createFindToolDefinition(ctx.cwd, { operations: createFindOperations(sandbox) }).execute(
				id,
				params,
				signal,
				onUpdate,
				ctx,
			);
		},
	});

	pi.registerTool({
		...localGrep,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const sandbox = sandboxParams(ctx);
			if (!sandbox) return localGrep.execute("grep", params, signal, _onUpdate, ctx);
			return executeSandboxedGrep(sandbox, params, signal);
		},
	});

	pi.on("user_bash", async (_event, ctx) => {
		const profile = getSandboxProfile(ctx);
		return { operations: createSandboxedBashOperations({ bwrapCommand, profile }) };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const profile = getSandboxProfile(ctx);
		if (!profile) return;
		const localLine = `Current working directory: ${ctx.cwd}`;
		const sandboxLine = `Current working directory: ${ctx.cwd} (Linux bubblewrap sandbox, profile ${profile}; HOME is fake, only runtime paths plus workspace are mounted, and Pyrun pi bridge capabilities are unavailable)`;
		const systemPrompt = event.systemPrompt.includes(localLine)
			? event.systemPrompt.replace(localLine, sandboxLine)
			: `${event.systemPrompt}\n\n${sandboxLine}`;
		return { systemPrompt };
	});

	pi.registerCommand("bwrap", {
		description: "Show bubblewrap sandbox status",
		handler: async (_args, ctx) => {
			const profile = getSandboxProfile(ctx);
			const mode = profile ? `sandboxed (${profile})` : "unsandboxed/full-access";
			ctx.ui.notify([`bwrap backend: ${mode}`, `cwd: ${ctx.cwd}`, `bwrap: ${bwrapCommand}`].join("\n"), "info");
		},
	});
}
