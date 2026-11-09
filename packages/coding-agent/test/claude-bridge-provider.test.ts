import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bridge, { __test } from "../extensions/claude-bridge/src/index.ts";
import { resetCtx } from "../extensions/claude-bridge/src/query-state.ts";

type BridgeMcpServer = { instance: { connect(transport: unknown): Promise<void> } };

type ListedTool = { name: string; inputSchema: unknown };

let testRoot: string;

const tool = {
	name: "read",
	description: "Read a file",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const piWebSearch = {
	name: "web_search",
	description: "Pi search",
	parameters: { type: "object", properties: { query: { type: "string" } } },
};

function activate(module = bridge) {
	const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
	const registered: Array<{ name: string; config: { models: Array<{ id: string; contextWindow: number }> } }> = [];
	module({
		cwd: testRoot,
		events: new EventEmitter(),
		on(event: string, handler: (...args: unknown[]) => void) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerProvider(name: string, config: (typeof registered)[number]["config"]) {
			registered.push({ name, config });
		},
		registerTool() {},
	} as never);
	return {
		handlers,
		registered,
		emit(event: string, ...args: unknown[]) {
			for (const handler of handlers.get(event) ?? []) handler(...args);
		},
	};
}

async function listMcpTools(server: BridgeMcpServer) {
	let nextId = 0;
	const pending = new Map<number, (message: { result?: { tools: ListedTool[] } }) => void>();
	const transport: {
		start: () => Promise<void>;
		close: () => Promise<void>;
		send: (message: { id?: number; result?: { tools: ListedTool[] } }) => Promise<void>;
		onmessage?: (message: unknown) => void;
	} = {
		start: async () => {},
		close: async () => {},
		send: async (message) => {
			if (message.id !== undefined) {
				pending.get(message.id)?.(message);
				pending.delete(message.id);
			}
		},
	};
	await server.instance.connect(transport as never);
	const request = (method: string, params: Record<string, unknown>) =>
		new Promise<{ result?: { tools: ListedTool[] } }>((resolve) => {
			const id = ++nextId;
			pending.set(id, resolve);
			transport.onmessage?.({ jsonrpc: "2.0", id, method, params });
		});
	await request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "claude-bridge-test", version: "1.0.0" },
	});
	transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/initialized" });
	return (await request("tools/list", {})).result?.tools ?? [];
}

describe("claude bridge provider registration", () => {
	beforeEach(() => {
		testRoot = mkdtempSync(join(tmpdir(), "bridge-provider-test-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(testRoot, "agent"));
	});

	afterEach(async () => {
		for (const context of __test.activeQueryContexts) context.releasePendingToolCalls("test cleanup");
		await new Promise((resolve) => setImmediate(resolve));
		__test.setQuery(null);
		__test.setIsolatedQuery(null);
		__test.resetSharedSession();
		resetCtx();
		rmSync(testRoot, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("registers its provider and usable model metadata", () => {
		const { registered } = activate();

		expect(registered).toHaveLength(1);
		expect(registered[0].name).toBe("claude-bridge");
		expect(registered[0].config.models.length).toBeGreaterThan(0);
		expect(registered[0].config.models.every((model) => model.id.startsWith("claude-"))).toBe(true);
	});

	it("registers a later module only when the session registry lacks this provider", async () => {
		const { default: freshBridge } = await import("../extensions/claude-bridge/src/index.ts?bridge-own-registry");
		const { registered, emit } = activate(freshBridge);

		expect(registered).toHaveLength(0);
		emit(
			"session_start",
			{},
			{ modelRegistry: { getProvider: (id: string) => (id === "another" ? {} : undefined) } },
		);
		expect(registered).toHaveLength(1);
		expect(registered[0].name).toBe("claude-bridge");
	});

	it("uses native WebSearch and excludes only Pi web_search from the MCP tool list", async () => {
		const { registered, emit } = activate();
		if (registered.length === 0) {
			emit("session_start", {}, { modelRegistry: { getProvider: () => undefined } });
		}
		const provider = registered[0].config as (typeof registered)[number]["config"] & {
			streamSimple: (model: unknown, input: unknown, options: unknown) => { result: () => Promise<unknown> };
		};
		const observed: Array<{ tools: string[]; server: BridgeMcpServer }> = [];
		const fakeQuery = ({
			options,
		}: {
			options: { tools: string[]; mcpServers: Record<string, BridgeMcpServer> };
		}) => {
			observed.push({ tools: options.tools, server: options.mcpServers["custom-tools"] });
			const generator = (async function* () {
				yield { type: "result", subtype: "success", is_error: false, result: "done" };
			})();
			Object.assign(generator, { interrupt: async () => {}, close: () => {} });
			return generator;
		};
		__test.setQuery(fakeQuery as never);

		const stream = provider.streamSimple(
			provider.models[0],
			{
				messages: [{ role: "user", content: "Search the web", timestamp: 1 }],
				tools: [piWebSearch, tool],
			},
			{ cwd: testRoot, sessionId: "native-search-test" },
		);
		await stream.result();

		expect(observed).toHaveLength(1);
		expect(observed[0].tools).toEqual(["WebSearch"]);
		const listed = await listMcpTools(observed[0].server);
		expect(listed.map((entry) => entry.name)).toEqual(["read"]);
		expect(listed[0].inputSchema).toEqual(tool.parameters);
	});
});
