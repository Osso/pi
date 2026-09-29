import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getControlDbPath } from "../src/core/session-control-db.ts";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void> };
	state: { messages: AgentMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	services: { agentDir: string };
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
	endTurn?: boolean;
}): AssistantMessage {
	return {
		role: "assistant",
		content: [
			...(options?.text ? [{ type: "text" as const, text: options.text }] : []),
			...(options?.endTurn
				? [{ type: "toolCall" as const, id: "finish", name: "end_turn", arguments: { reason: "finished" } }]
				: []),
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(messages: AssistantMessage | AgentMessage[]): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: Array.isArray(messages) ? messages : [messages] };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {} },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	};

	return {
		session,
		services: { agentDir: join("/tmp", "pi-print-mode-agent") },
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

function captureStdout(): string[] {
	const output: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(
		(
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		) => {
			output.push(String(chunk));
			if (typeof encodingOrCallback === "function") encodingOrCallback();
			else callback?.();
			return true;
		},
	);
	return output;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("binds the control database path for runtime mailbox draining", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(0);
		expect(session.bindExtensions).toHaveBeenCalledWith(
			expect.objectContaining({
				controlDbPath: getControlDbPath(),
			}),
		);
	});

	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("prints an ordinary final assistant response", async () => {
		const output = captureStdout();
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "ordinary answer" }));
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});
		expect(exitCode).toBe(0);
		expect(output.join("")).toBe("ordinary answer\n");
	});

	it("prints the last answer before a terminating tool result", async () => {
		const output = captureStdout();
		const runtimeHost = createRuntimeHost([
			{ role: "user", content: "question", timestamp: 1 },
			createAssistantMessage({ text: "final answer", stopReason: "toolUse", endTurn: true }),
			{ role: "toolResult", toolCallId: "finish", toolName: "end_turn", content: [], isError: false, timestamp: 2 },
		]);
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});
		expect(exitCode).toBe(0);
		expect(output.join("")).toBe("final answer\n");
	});

	it("prints a separate answer before a textless end_turn assistant", async () => {
		const output = captureStdout();
		const runtimeHost = createRuntimeHost([
			{ role: "user", content: "question", timestamp: 1 },
			createAssistantMessage({ text: "final answer" }),
			createAssistantMessage({ stopReason: "toolUse", endTurn: true }),
			{ role: "toolResult", toolCallId: "finish", toolName: "end_turn", content: [], isError: false, timestamp: 2 },
		]);
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});
		expect(exitCode).toBe(0);
		expect(output.join("")).toBe("final answer\n");
	});

	it("does not print intermediate tool chatter as the final answer", async () => {
		const output = captureStdout();
		const runtimeHost = createRuntimeHost([
			{ role: "user", content: "question", timestamp: 1 },
			createAssistantMessage({ text: "running a tool", stopReason: "toolUse" }),
			{ role: "toolResult", toolCallId: "other", toolName: "read", content: [], isError: false, timestamp: 2 },
			createAssistantMessage({ stopReason: "toolUse", endTurn: true }),
			{ role: "toolResult", toolCallId: "finish", toolName: "end_turn", content: [], isError: false, timestamp: 3 },
		]);
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});
		expect(exitCode).toBe(0);
		expect(output.join("")).toBe("");
	});

	it("does not print an answer from an earlier prompt", async () => {
		const output = captureStdout();
		const runtimeHost = createRuntimeHost([
			{ role: "user", content: "first", timestamp: 1 },
			createAssistantMessage({ text: "old answer" }),
			{ role: "user", content: "second", timestamp: 2 },
			createAssistantMessage({ stopReason: "toolUse", endTurn: true }),
			{ role: "toolResult", toolCallId: "finish", toolName: "end_turn", content: [], isError: false, timestamp: 3 },
		]);
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});
		expect(exitCode).toBe(0);
		expect(output.join("")).toBe("");
	});

	it.each(["error", "aborted"] as const)(
		"reports a trailing %s without printing the earlier answer",
		async (stopReason) => {
			const output = captureStdout();
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const runtimeHost = createRuntimeHost([
				{ role: "user", content: "question", timestamp: 1 },
				createAssistantMessage({ text: "earlier answer" }),
				createAssistantMessage({ stopReason, errorMessage: "latest failure" }),
			]);
			const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
				mode: "text",
			});
			expect(exitCode).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith("latest failure");
			expect(output.join("")).toBe("");
		},
	);
});
