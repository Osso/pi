import { inspect } from "node:util";
import { getQuickJS, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten";

export const defaultHostrunSessionId = "default";

export interface HostrunEvalRequest {
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

class HostrunSession {
	private context: QuickJSContext | undefined;
	private consoleEntries: HostrunConsoleEntry[] = [];

	async evaluate(code: string, sessionId: string): Promise<HostrunEvalResult> {
		const context = await this.getContext();
		this.consoleEntries = [];

		const result = context.evalCode(code, `<hostrun:${sessionId}>`);
		if (result.error) {
			const error = this.dumpHandle(context, result.error);
			result.error.dispose();
			return { code, console: this.consoleEntries, error: toEvalError(error), result: undefined, sessionId };
		}

		const value = this.dumpHandle(context, result.value);
		result.value.dispose();
		return { code, console: this.consoleEntries, result: value, sessionId };
	}

	private async getContext(): Promise<QuickJSContext> {
		if (this.context) {
			return this.context;
		}

		const quickjs = await getQuickJS();
		const context = quickjs.newContext();
		this.installCtx(context);
		this.installConsole(context);
		this.context = context;
		return context;
	}

	private installCtx(context: QuickJSContext): void {
		const ctx = context.newObject();
		context.setProp(context.global, "ctx", ctx);
		ctx.dispose();
	}

	private installConsole(context: QuickJSContext): void {
		const consoleHandle = context.newObject();
		for (const level of ["debug", "error", "info", "log", "warn"] as const) {
			const method = this.createConsoleMethod(context, level);
			context.setProp(consoleHandle, level, method);
			method.dispose();
		}
		context.setProp(context.global, "console", consoleHandle);
		consoleHandle.dispose();
	}

	private createConsoleMethod(context: QuickJSContext, level: HostrunConsoleEntry["level"]): QuickJSHandle {
		return context.newFunction(level, (...values) => {
			this.captureConsoleValues(context, level, values);
		});
	}

	private captureConsoleValues(context: QuickJSContext, level: HostrunConsoleEntry["level"], values: QuickJSHandle[]): void {
		const text = values.map((value) => formatConsoleValue(context.dump(value))).join(" ");
		this.consoleEntries.push({ level, text });
	}

	private dumpHandle(context: QuickJSContext, handle: QuickJSHandle): unknown {
		return context.dump(handle);
	}
}

export class HostrunSessionStore {
	private readonly sessions = new Map<string, HostrunSession>();

	evaluate(request: HostrunEvalRequest): Promise<HostrunEvalResult> {
		const sessionId = request.sessionId ?? defaultHostrunSessionId;
		return this.getSession(sessionId).evaluate(request.code, sessionId);
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
