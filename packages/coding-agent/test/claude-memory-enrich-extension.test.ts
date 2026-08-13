import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import claudeMemoryEnrichExtension from "../extensions/claude-memory-enrich/src/index.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const ORIGINAL_DEADLINE_MS = 15_000;
const ENRICH_DEADLINE_MS = 75_000;
const TERMINATION_GRACE_MS = 1_000;

const ENRICH_SECTION = "<claude_memory_enrich>\nretrieved context\n</claude_memory_enrich>";

type BeforeAgentStartHandler = (
	event: { prompt: string; systemPrompt: string },
	ctx: { signal: AbortSignal },
) => Promise<{ systemPrompt: string } | undefined>;

type FakeChild = EventEmitter & {
	stdin: { end: ReturnType<typeof vi.fn> };
	stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
	stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
	kill: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
	return Object.assign(new EventEmitter(), {
		stdin: { end: vi.fn() },
		stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
		stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
		kill: vi.fn(),
	});
}

function registerBeforeAgentStartHandler(): BeforeAgentStartHandler {
	let handler: BeforeAgentStartHandler | undefined;
	const pi = {
		on(event: string, registeredHandler: BeforeAgentStartHandler) {
			if (event === "before_agent_start") handler = registeredHandler;
		},
	} as unknown as ExtensionAPI;
	claudeMemoryEnrichExtension(pi);
	if (!handler) throw new Error("before_agent_start handler not registered");
	return handler;
}

function completeSuccessfully(child: FakeChild, context = "{}"): void {
	child.stdout.emit("data", `${context}\n`);
	child.emit("close", 0);
}

describe("claude-memory enrich extension", () => {
	let previousCommand: string | undefined;

	beforeEach(() => {
		spawnMock.mockReset();
		previousCommand = process.env.PI_CLAUDE_MEMORY;
		process.env.PI_CLAUDE_MEMORY = "/tmp/pi-test-claude-memory";
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (previousCommand === undefined) delete process.env.PI_CLAUDE_MEMORY;
		else process.env.PI_CLAUDE_MEMORY = previousCommand;
	});

	it("queues concurrent enrich subprocesses until the previous one closes", async () => {
		const firstChild = fakeChild();
		const secondChild = fakeChild();
		spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
		const handler = registerBeforeAgentStartHandler();
		const context = { signal: new AbortController().signal };

		const firstResult = handler({ prompt: "first prompt", systemPrompt: "system" }, context);
		const secondResult = handler({ prompt: "second prompt", systemPrompt: "system" }, context);

		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
		expect(firstChild.stdin.end).toHaveBeenCalledWith('{"prompt":"first prompt"}\n');
		completeSuccessfully(firstChild);
		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
		expect(secondChild.stdin.end).toHaveBeenCalledWith('{"prompt":"second prompt"}\n');
		completeSuccessfully(secondChild);
		await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([undefined, undefined]);
	});

	it("allows enrichment to finish after the original fifteen-second deadline", async () => {
		vi.useFakeTimers();
		const child = fakeChild();
		spawnMock.mockReturnValue(child);
		const handler = registerBeforeAgentStartHandler();
		const result = handler(
			{ prompt: "retrieve context", systemPrompt: "system" },
			{ signal: new AbortController().signal },
		);

		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
		await vi.advanceTimersByTimeAsync(ORIGINAL_DEADLINE_MS + 1);
		expect(child.kill).not.toHaveBeenCalled();

		completeSuccessfully(child, JSON.stringify({ hookSpecificOutput: { additionalContext: "retrieved context" } }));

		await expect(result).resolves.toMatchObject({ systemPrompt: expect.stringContaining(ENRICH_SECTION) });
	});

	it("waits for close before advancing the queue and escalates a timed-out child", async () => {
		vi.useFakeTimers();
		const firstChild = fakeChild();
		const secondChild = fakeChild();
		spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const handler = registerBeforeAgentStartHandler();
		const context = { signal: new AbortController().signal };

		const firstResult = handler({ prompt: "slow first prompt", systemPrompt: "system" }, context);
		const secondResult = handler({ prompt: "queued second prompt", systemPrompt: "system" }, context);

		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
		await vi.advanceTimersByTimeAsync(ENRICH_DEADLINE_MS);
		expect(firstChild.kill).toHaveBeenCalledTimes(1);
		expect(firstChild.kill).toHaveBeenCalledWith("SIGTERM");
		expect(errorSpy).not.toHaveBeenCalled();
		expect(spawnMock).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(TERMINATION_GRACE_MS);
		expect(firstChild.kill).toHaveBeenCalledTimes(2);
		expect(firstChild.kill).toHaveBeenLastCalledWith("SIGKILL");
		expect(errorSpy).not.toHaveBeenCalled();
		expect(spawnMock).toHaveBeenCalledTimes(1);

		firstChild.emit("close", null);
		await expect(firstResult).resolves.toBeUndefined();
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith("claude-memory-enrich: claude-memory enrich timed out after 75000ms");

		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
		completeSuccessfully(secondChild);
		await expect(secondResult).resolves.toBeUndefined();
	});

	it("logs a child error once and advances the FIFO after close", async () => {
		const firstChild = fakeChild();
		const secondChild = fakeChild();
		spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const handler = registerBeforeAgentStartHandler();
		const context = { signal: new AbortController().signal };

		const firstResult = handler({ prompt: "erroring prompt", systemPrompt: "system" }, context);
		const secondResult = handler({ prompt: "next prompt", systemPrompt: "system" }, context);

		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
		firstChild.emit("error", new Error("spawn failed"));
		firstChild.emit("close", 1);

		await expect(firstResult).resolves.toBeUndefined();
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith("claude-memory-enrich: spawn failed");
		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
		completeSuccessfully(secondChild);
		await expect(secondResult).resolves.toBeUndefined();
	});

	it("logs stderr once for a nonzero child exit", async () => {
		const child = fakeChild();
		spawnMock.mockReturnValue(child);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const handler = registerBeforeAgentStartHandler();
		const result = handler(
			{ prompt: "nonzero prompt", systemPrompt: "system" },
			{ signal: new AbortController().signal },
		);

		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
		child.stderr.emit("data", "backend failed\n");
		child.emit("close", 7);

		await expect(result).resolves.toBeUndefined();
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith("claude-memory-enrich: claude-memory enrich exited with 7: backend failed");
	});

	it("logs one parse failure for malformed JSON", async () => {
		const child = fakeChild();
		spawnMock.mockReturnValue(child);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const handler = registerBeforeAgentStartHandler();
		const result = handler(
			{ prompt: "malformed prompt", systemPrompt: "system" },
			{ signal: new AbortController().signal },
		);

		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
		child.stdout.emit("data", "{malformed\n");
		child.emit("close", 0);

		await expect(result).resolves.toBeUndefined();
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^claude-memory-enrich: .*JSON/i));
	});

	it("logs caller abort once when abort error is followed by close", async () => {
		const child = fakeChild();
		spawnMock.mockReturnValue(child);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const handler = registerBeforeAgentStartHandler();
		const controller = new AbortController();
		const result = handler(
			{ prompt: "aborted prompt", systemPrompt: "system" },
			{ signal: controller.signal },
		);

		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
		controller.abort();
		child.emit("error", Object.assign(new Error("operation aborted"), { name: "AbortError" }));
		child.emit("close", null);

		await expect(result).resolves.toBeUndefined();
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith("claude-memory-enrich: operation aborted");
	});
});
