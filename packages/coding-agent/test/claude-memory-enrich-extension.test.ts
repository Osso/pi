import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

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

async function registerBeforeAgentStartHandler(): Promise<BeforeAgentStartHandler> {
	let handler: BeforeAgentStartHandler | undefined;
	const pi = {
		on(event: string, registeredHandler: BeforeAgentStartHandler) {
			if (event === "before_agent_start") handler = registeredHandler;
		},
	} as unknown as ExtensionAPI;
	const { default: extension } = await import("../extensions/claude-memory-enrich/src/index.ts");
	extension(pi);
	if (!handler) throw new Error("before_agent_start handler not registered");
	return handler;
}

function completeSuccessfully(child: FakeChild): void {
	child.stdout.emit("data", "{}\n");
	child.emit("close", 0);
}

describe("claude-memory enrich extension", () => {
	let previousCommand: string | undefined;

	beforeEach(() => {
		vi.resetModules();
		spawnMock.mockReset();
		previousCommand = process.env.PI_CLAUDE_MEMORY;
		process.env.PI_CLAUDE_MEMORY = "/tmp/pi-test-claude-memory";
	});

	afterEach(() => {
		if (previousCommand === undefined) delete process.env.PI_CLAUDE_MEMORY;
		else process.env.PI_CLAUDE_MEMORY = previousCommand;
	});

	it("queues concurrent enrich subprocesses until the previous one closes", async () => {
		const firstChild = fakeChild();
		const secondChild = fakeChild();
		spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
		const handler = await registerBeforeAgentStartHandler();
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
});
