import { createContext, Script, type Context } from "node:vm";
import { inspect } from "node:util";

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

type HostrunConsoleMethod = (...values: unknown[]) => void;

interface HostrunConsole {
	debug: HostrunConsoleMethod;
	error: HostrunConsoleMethod;
	info: HostrunConsoleMethod;
	log: HostrunConsoleMethod;
	warn: HostrunConsoleMethod;
}

interface HostrunVmContext extends Context {
	console: HostrunConsole;
	ctx: Record<string, unknown>;
}

function formatConsoleValue(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	return inspect(value, { colors: false, depth: 6 });
}

function createConsoleCapture(entries: HostrunConsoleEntry[]): HostrunConsole {
	const capture = (level: HostrunConsoleEntry["level"]) => {
		return (...values: unknown[]) => {
			entries.push({ level, text: values.map(formatConsoleValue).join(" ") });
		};
	};

	return {
		debug: capture("debug"),
		error: capture("error"),
		info: capture("info"),
		log: capture("log"),
		warn: capture("warn"),
	};
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

function createHostrunContext(): HostrunVmContext {
	const sandbox = {
		console: createConsoleCapture([]),
		ctx: {},
	};
	return createContext(sandbox) as HostrunVmContext;
}

class HostrunSession {
	private readonly context = createHostrunContext();

	evaluate(code: string, sessionId: string): HostrunEvalResult {
		const consoleEntries: HostrunConsoleEntry[] = [];
		this.context.console = createConsoleCapture(consoleEntries);

		try {
			const script = new Script(code, { filename: `<hostrun:${sessionId}>` });
			const result = script.runInContext(this.context);
			return { code, console: consoleEntries, result, sessionId };
		} catch (error) {
			return { code, console: consoleEntries, error: toEvalError(error), result: undefined, sessionId };
		}
	}
}

export class HostrunSessionStore {
	private readonly sessions = new Map<string, HostrunSession>();

	evaluate(request: HostrunEvalRequest): HostrunEvalResult {
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
