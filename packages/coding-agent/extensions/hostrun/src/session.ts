import { execFile } from "node:child_process";
import { access, glob, readFile, rm, writeFile } from "node:fs/promises";
import { inspect } from "node:util";
import { promisify } from "node:util";
import { newAsyncContext, type QuickJSAsyncContext, type QuickJSHandle } from "quickjs-emscripten";

const execFileAsync = promisify(execFile);

export const defaultHostrunSessionId = "default";

export interface HostrunEvalRequest {
	approval: HostrunApproval;
	code: string;
	sessionId?: string;
}

export interface HostrunConsoleEntry {
	level: "debug" | "error" | "info" | "log" | "warn";
	text: string;
}

export interface HostrunEvalError {
	name: string;
	message: string;
}

export interface HostrunEvalResult {
	code: string;
	sessionId: string;
	result: unknown;
	console: HostrunConsoleEntry[];
	error?: HostrunEvalError;
}

export interface HostrunApprovalRequest {
	message: string;
	title: string;
}

export type HostrunApproval = (request: HostrunApprovalRequest) => Promise<boolean>;

function formatConsoleValue(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	return inspect(value, { colors: false, depth: 6 });
}

function toEvalError(error: unknown): HostrunEvalError {
	if (error instanceof Error) {
		return { name: error.name, message: error.message };
	}
	if (typeof error === "object" && error !== null) {
		const name = "name" in error && typeof error.name === "string" ? error.name : "Error";
		const message = "message" in error && typeof error.message === "string" ? error.message : String(error);
		return { name, message };
	}
	return { name: "Error", message: String(error) };
}

function stringifyArgs(value: unknown): string[] {
	if (!Array.isArray(value)) {
		throw new Error("Hostrun expected an argument array");
	}
	return value.map((item) => String(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactApprovalValue(key: string, value: unknown): unknown {
	if (/(?:authorization|cookie|token|key|secret)/i.test(key)) {
		return "[redacted]";
	}
	if (Array.isArray(value)) {
		return value.map((item) => redactApprovalValue(key, item));
	}
	if (isRecord(value)) {
		return redactApprovalMetadata(value);
	}
	return value;
}

function redactApprovalMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, redactApprovalValue(key, value)]));
}

class HostrunSession {
	private approval: HostrunApproval | undefined;
	private context: QuickJSAsyncContext | undefined;
	private consoleEntries: HostrunConsoleEntry[] = [];

	async evaluate(request: HostrunEvalRequest, sessionId: string): Promise<HostrunEvalResult> {
		this.approval = request.approval;
		const context = await this.getContext();
		this.consoleEntries = [];

		const result = await context.evalCodeAsync(request.code, `<hostrun:${sessionId}>`);
		if (result.error) {
			const error = this.dumpHandle(context, result.error);
			result.error.dispose();
			return { code: request.code, console: this.consoleEntries, error: toEvalError(error), result: undefined, sessionId };
		}

		const value = this.dumpHandle(context, result.value);
		result.value.dispose();
		return { code: request.code, console: this.consoleEntries, result: value, sessionId };
	}

	private async getContext(): Promise<QuickJSAsyncContext> {
		if (this.context) {
			return this.context;
		}

		const context = await newAsyncContext();
		this.installCtx(context);
		this.installConsole(context);
		this.installHostLibrary(context);
		this.context = context;
		return context;
	}

	private installCtx(context: QuickJSAsyncContext): void {
		const ctx = context.newObject();
		context.setProp(context.global, "ctx", ctx);
		ctx.dispose();
	}

	private installConsole(context: QuickJSAsyncContext): void {
		const consoleHandle = context.newObject();
		for (const level of ["debug", "error", "info", "log", "warn"] as const) {
			const method = this.createConsoleMethod(context, level);
			context.setProp(consoleHandle, level, method);
			method.dispose();
		}
		context.setProp(context.global, "console", consoleHandle);
		consoleHandle.dispose();
	}

	private createConsoleMethod(context: QuickJSAsyncContext, level: HostrunConsoleEntry["level"]): QuickJSHandle {
		return context.newFunction(level, (...values) => {
			this.captureConsoleValues(context, level, values);
		});
	}

	private installHostLibrary(context: QuickJSAsyncContext): void {
		const cliFactory = context.newFunction("__hostrunCli", (programHandle, argsHandle) => {
			const program = String(context.dump(programHandle));
			const args = stringifyArgs(context.dump(argsHandle));
			return this.createCliBuilder(context, program, args);
		});
		context.setProp(context.global, "__hostrunCli", cliFactory);
		cliFactory.dispose();

		const fsWrite = context.newAsyncifiedFunction("__hostrunFsWrite", async (pathHandle, contentHandle) => {
			const path = String(context.dump(pathHandle));
			const content = String(context.dump(contentHandle));
			await this.requireApproval({
				title: `Hostrun fs.write ${path}`,
				message: JSON.stringify({ operation: "fs.write", path }, null, 2),
			});
			await writeFile(path, content, "utf8");
			return context.undefined;
		});
		context.setProp(context.global, "__hostrunFsWrite", fsWrite);
		fsWrite.dispose();

		const fsRead = context.newAsyncifiedFunction("__hostrunFsRead", async (pathHandle) => {
			const path = String(context.dump(pathHandle));
			await this.requireApproval({
				title: `Hostrun fs.read ${path}`,
				message: JSON.stringify({ operation: "fs.read", path }, null, 2),
			});
			return context.newString(await readFile(path, "utf8"));
		});
		context.setProp(context.global, "__hostrunFsRead", fsRead);
		fsRead.dispose();

		const fsExists = context.newAsyncifiedFunction("__hostrunFsExists", async (pathHandle) => {
			const path = String(context.dump(pathHandle));
			await this.requireApproval({
				title: `Hostrun fs.exists ${path}`,
				message: JSON.stringify({ operation: "fs.exists", path }, null, 2),
			});
			try {
				await access(path);
				return context.true;
			} catch {
				return context.false;
			}
		});
		context.setProp(context.global, "__hostrunFsExists", fsExists);
		fsExists.dispose();

		const fsRemove = context.newAsyncifiedFunction("__hostrunFsRemove", async (pathHandle) => {
			const path = String(context.dump(pathHandle));
			await this.requireApproval({
				title: `Hostrun fs.remove ${path}`,
				message: JSON.stringify({ operation: "fs.remove", path }, null, 2),
			});
			await rm(path, { force: true, recursive: true });
			return context.undefined;
		});
		context.setProp(context.global, "__hostrunFsRemove", fsRemove);
		fsRemove.dispose();

		const fsGlob = context.newAsyncifiedFunction("__hostrunFsGlob", async (patternHandle) => {
			const pattern = String(context.dump(patternHandle));
			await this.requireApproval({
				title: `Hostrun fs.glob ${pattern}`,
				message: JSON.stringify({ operation: "fs.glob", pattern }, null, 2),
			});
			const matches: string[] = [];
			for await (const match of glob(pattern)) {
				matches.push(match);
			}
			return this.createJsonHandle(context, matches);
		});
		context.setProp(context.global, "__hostrunFsGlob", fsGlob);
		fsGlob.dispose();

		const httpGet = context.newFunction("__hostrunHttpGet", (urlHandle) => {
			const url = String(context.dump(urlHandle));
			return this.createHttpBuilder(context, "GET", url);
		});
		context.setProp(context.global, "__hostrunHttpGet", httpGet);
		httpGet.dispose();

		const httpPost = context.newFunction("__hostrunHttpPost", (urlHandle, optionsHandle) => {
			const url = String(context.dump(urlHandle));
			const options = this.dumpHandle(context, optionsHandle);
			return this.createHttpBuilder(context, "POST", url, isRecord(options) ? options : {});
		});
		context.setProp(context.global, "__hostrunHttpPost", httpPost);
		httpPost.dispose();

		const runFactory = context.newAsyncifiedFunction("__hostrunRun", async (programHandle, argsHandle) => {
			const program = String(context.dump(programHandle));
			const args = stringifyArgs(context.dump(argsHandle));
			return this.runProcess(context, program, args, false);
		});
		context.setProp(context.global, "__hostrunRun", runFactory);
		runFactory.dispose();

		const bootstrap = context.evalCode(`
			globalThis.cli = new Proxy({}, {
				get(_target, program) {
					return (...args) => globalThis.__hostrunCli(String(program), args);
				},
			});
			globalThis.run = new Proxy({}, {
				get(_target, program) {
					return (...args) => globalThis.__hostrunRun(String(program), args);
				},
			});
			globalThis.fs = {
				exists(path) { return globalThis.__hostrunFsExists(path); },
				glob(pattern) { return globalThis.__hostrunFsGlob(pattern); },
				read(path) { return globalThis.__hostrunFsRead(path); },
				remove(path) { return globalThis.__hostrunFsRemove(path); },
				write(path, content) { return globalThis.__hostrunFsWrite(path, content); },
			};
			globalThis.http = {
				get(url) { return globalThis.__hostrunHttpGet(url); },
				post(url, options = {}) { return globalThis.__hostrunHttpPost(url, options); },
			};
		`);
		if (bootstrap.error) {
			const error = this.dumpHandle(context, bootstrap.error);
			bootstrap.error.dispose();
			throw new Error(`Failed to install Hostrun helpers: ${toEvalError(error).message}`);
		}
		bootstrap.value.dispose();
	}

	private createCliBuilder(context: QuickJSAsyncContext, program: string, args: string[]): QuickJSHandle {
		const builder = context.newObject();
		const stdout = context.newObject();
		const text = context.newAsyncifiedFunction("text", async () => {
			const result = await this.executeProcess(program, args);
			return context.newString(result.stdout);
		});
		context.setProp(stdout, "text", text);
		text.dispose();
		context.setProp(builder, "stdout", stdout);
		stdout.dispose();

		const run = context.newAsyncifiedFunction("run", async () => {
			return this.createJsonHandle(context, await this.executeProcess(program, args));
		});
		context.setProp(builder, "run", run);
		run.dispose();
		return builder;
	}

	private createHttpBuilder(
		context: QuickJSAsyncContext,
		method: string,
		url: string,
		options: Record<string, unknown> = {},
	): QuickJSHandle {
		const builder = context.newObject();
		const text = context.newAsyncifiedFunction("text", async () => {
			const approvalMetadata = redactApprovalMetadata({ method, operation: "http", url, ...options });
			await this.requireApproval({
				title: `Hostrun http.${method.toLowerCase()} ${url}`,
				message: JSON.stringify(approvalMetadata, null, 2),
			});
			const response = await fetch(url, { ...options, method });
			return context.newString(await response.text());
		});
		context.setProp(builder, "text", text);
		text.dispose();
		return builder;
	}

	private async executeProcess(
		program: string,
		args: string[],
	): Promise<{ exitCode: number; signal: string | null; stderr: string; stdout: string }> {
		await this.requireApproval({
			title: `Hostrun cli.${program}`,
			message: JSON.stringify({ args, operation: "cli", program }, null, 2),
		});
		try {
			const result = await execFileAsync(program, args);
			return { exitCode: 0, signal: null, stderr: result.stderr, stdout: result.stdout };
		} catch (error) {
			if (isRecord(error)) {
				return {
					exitCode: typeof error.code === "number" ? error.code : 1,
					signal: typeof error.signal === "string" ? error.signal : null,
					stderr: typeof error.stderr === "string" ? error.stderr : "",
					stdout: typeof error.stdout === "string" ? error.stdout : "",
				};
			}
			throw error;
		}
	}

	private async runProcess(
		context: QuickJSAsyncContext,
		program: string,
		args: string[],
		capture: boolean,
	): Promise<QuickJSHandle> {
		const result = await this.executeProcess(program, args);
		return capture ? this.createJsonHandle(context, result) : context.undefined;
	}

	private createJsonHandle(context: QuickJSAsyncContext, value: unknown): QuickJSHandle {
		const json = JSON.stringify(value);
		if (json === undefined) {
			return context.undefined;
		}
		const result = context.evalCode(`JSON.parse(${JSON.stringify(json)})`);
		if (result.error) {
			const error = this.dumpHandle(context, result.error);
			result.error.dispose();
			throw new Error(`Failed to convert Hostrun value: ${toEvalError(error).message}`);
		}
		return result.value;
	}

	private async requireApproval(request: HostrunApprovalRequest): Promise<void> {
		const approved = await this.approval?.(request);
		if (!approved) {
			throw new Error(`Hostrun operation denied: ${request.title}`);
		}
	}

	private captureConsoleValues(
		context: QuickJSAsyncContext,
		level: HostrunConsoleEntry["level"],
		values: QuickJSHandle[],
	): void {
		const text = values.map((value) => formatConsoleValue(context.dump(value))).join(" ");
		this.consoleEntries.push({ level, text });
	}

	private dumpHandle(context: QuickJSAsyncContext, handle: QuickJSHandle): unknown {
		return context.dump(handle);
	}
}

export class HostrunSessionStore {
	private readonly sessions = new Map<string, HostrunSession>();

	evaluate(request: HostrunEvalRequest): Promise<HostrunEvalResult> {
		const sessionId = request.sessionId ?? defaultHostrunSessionId;
		return this.getSession(sessionId).evaluate(request, sessionId);
	}

	private getSession(sessionId: string): HostrunSession {
		const existing = this.sessions.get(sessionId);
		if (existing) {
			return existing;
		}

		const session = new HostrunSession();
		this.sessions.set(sessionId, session);
		return session;
	}
}
