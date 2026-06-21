import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
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

		const httpGet = context.newFunction("__hostrunHttpGet", (urlHandle) => {
			const url = String(context.dump(urlHandle));
			return this.createHttpBuilder(context, "GET", url);
		});
		context.setProp(context.global, "__hostrunHttpGet", httpGet);
		httpGet.dispose();

		const bootstrap = context.evalCode(`
			globalThis.cli = new Proxy({}, {
				get(_target, program) {
					return (...args) => globalThis.__hostrunCli(String(program), args);
				},
			});
			globalThis.fs = {
				read(path) { return globalThis.__hostrunFsRead(path); },
				write(path, content) { return globalThis.__hostrunFsWrite(path, content); },
			};
			globalThis.http = {
				get(url) { return globalThis.__hostrunHttpGet(url); },
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
			await this.requireApproval({
				title: `Hostrun cli.${program}`,
				message: JSON.stringify({ args, operation: "cli", program }, null, 2),
			});
			const result = await execFileAsync(program, args);
			return context.newString(result.stdout);
		});
		context.setProp(stdout, "text", text);
		text.dispose();
		context.setProp(builder, "stdout", stdout);
		stdout.dispose();
		return builder;
	}

	private createHttpBuilder(context: QuickJSAsyncContext, method: string, url: string): QuickJSHandle {
		const builder = context.newObject();
		const text = context.newAsyncifiedFunction("text", async () => {
			await this.requireApproval({
				title: `Hostrun http.${method.toLowerCase()} ${url}`,
				message: JSON.stringify({ method, operation: "http", url }, null, 2),
			});
			const response = await fetch(url, { method });
			return context.newString(await response.text());
		});
		context.setProp(builder, "text", text);
		text.dispose();
		return builder;
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
