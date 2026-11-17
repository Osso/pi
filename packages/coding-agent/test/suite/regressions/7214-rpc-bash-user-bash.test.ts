import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { ExtensionAPI, UserBashEventResult } from "../../../src/core/extensions/types.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

// Regression for https://github.com/earendil-works/pi-mono/pull/7214 (RPC bash bypassed user_bash) and
// https://github.com/earendil-works/pi-mono/issues/9068 (failing user_bash handlers must fail closed).

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../../../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

type ListenerSnapshot = {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
};

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) {
			process.stdin.off("end", listener);
		}
	}

	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) {
				process.off(signal, listener);
			}
		}
	}
}

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
		diagnostics: [],
	} as unknown as AgentSessionRuntime;
}

const handledResult = { output: "handled", exitCode: 0, cancelled: false, truncated: false };
const localResult = { output: "local output", exitCode: 0, cancelled: false, truncated: false };

const cases: Array<{
	name: string;
	extension: (pi: ExtensionAPI) => void;
	expected: Record<string, unknown>;
	executeCount: number;
}> = [
	{
		name: "uses a user_bash result without executing bash",
		extension: (pi) => {
			pi.on("user_bash", async () => ({ result: handledResult }));
		},
		expected: { success: true, data: handledResult },
		executeCount: 0,
	},
	{
		name: "passes user_bash operations to executeBash",
		extension: (pi) => {
			pi.on("user_bash", async () => ({ operations: { exec: async () => ({ exitCode: 0 }) } }));
		},
		expected: { success: true, data: localResult },
		executeCount: 1,
	},
	{
		name: "fails the request without executing bash when a handler throws",
		extension: (pi) => {
			pi.on("user_bash", async () => {
				throw new Error("Routing failed");
			});
		},
		expected: { success: false, error: "Routing failed" },
		executeCount: 0,
	},
	{
		name: "fails the request without executing bash when a handler returns an invalid result",
		extension: (pi) => {
			pi.on("user_bash", async () => ({}) as unknown as UserBashEventResult);
		},
		expected: { success: false, error: expect.stringContaining("Invalid user_bash handler result") },
		executeCount: 0,
	},
];

describe("RPC bash routes through user_bash", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	test.each(cases)("$name", async ({ extension, expected, executeCount }) => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness({ extensionFactories: [extension] });
		const executeBash = vi.spyOn(harness.session, "executeBash").mockResolvedValue(localResult);

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(JSON.stringify({ id: "bash-request", type: "bash", command: "pwd" }));

			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "bash-request",
					type: "response",
					command: "bash",
					...expected,
				});
			});
			expect(executeBash).toHaveBeenCalledTimes(executeCount);
			if (executeCount > 0) {
				expect(executeBash.mock.calls[0]?.[2]?.operations?.exec).toEqual(expect.any(Function));
			}
		} finally {
			executeBash.mockRestore();
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});
});
