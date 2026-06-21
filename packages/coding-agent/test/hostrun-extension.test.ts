import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import hostrunExtension from "../extensions/hostrun/src/index.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";

interface HostrunEvalParams {
	code: string;
	session_id?: string;
}

interface HostrunConsoleEntry {
	level: "debug" | "error" | "info" | "log" | "warn";
	text: string;
}

interface HostrunEvalDetails {
	code: string;
	sessionId: string;
	result: unknown;
	console: HostrunConsoleEntry[];
	error?: {
		name: string;
		message: string;
	};
}

type HostrunTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: HostrunEvalParams,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<HostrunEvalDetails>>;
};

function createHostrunHarness(options: { confirm?: (title: string, message: string) => Promise<boolean> } = {}) {
	let hostrunTool: HostrunTool | undefined;

	const pi = {
		registerTool(tool: ToolDefinition) {
			if (tool.name === "hostrun_eval") {
				hostrunTool = tool as unknown as HostrunTool;
			}
		},
	} as unknown as ExtensionAPI;

	hostrunExtension(pi);

	if (!hostrunTool) {
		throw new Error("hostrun_eval was not registered");
	}

	const registeredHostrunTool = hostrunTool;
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		mode: "tui",
		ui: {
			confirm: options.confirm ?? (async () => false),
		},
	} as ExtensionContext;

	return {
		evaluate: (params: HostrunEvalParams) =>
			registeredHostrunTool.execute("hostrun-test-call", params, undefined, undefined, ctx),
	};
}

function listen(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as AddressInfo;
			resolve(address.port);
		});
	});
}

describe("hostrun extension", () => {
	let tempDir: string;
	const servers: Server[] = [];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-hostrun-"));
	});

	afterEach(async () => {
		rmSync(tempDir, { recursive: true, force: true });
		await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
		servers.length = 0;
	});

	it("registers hostrun_eval with persistent ctx per session", async () => {
		const harness = createHostrunHarness();

		const first = await harness.evaluate({ code: "ctx.count = 41; ctx.count" });
		const second = await harness.evaluate({ code: "ctx.count += 1; ctx.count" });
		const named = await harness.evaluate({ code: "typeof ctx.count", session_id: "named" });

		expect(first.details).toMatchObject({ code: "ctx.count = 41; ctx.count", sessionId: "default", result: 41 });
		expect(second.details.result).toBe(42);
		expect(named.details).toMatchObject({ sessionId: "named", result: "undefined" });
	});

	it("keeps ctx alive after a JavaScript exception", async () => {
		const harness = createHostrunHarness();

		await harness.evaluate({ code: "ctx.survives = 'yes'; throw new Error('boom')" });
		const result = await harness.evaluate({ code: "ctx.survives" });

		expect(result.details.result).toBe("yes");
	});

	it("captures console output from evaluations", async () => {
		const harness = createHostrunHarness();

		const result = await harness.evaluate({
			code: "console.log('ready', { count: 2 }); console.warn('careful'); 'done'",
		});

		expect(result.details.console).toEqual([
			{ level: "log", text: "ready { count: 2 }" },
			{ level: "warn", text: "careful" },
		]);
		expect(result.details.result).toBe("done");
	});

	it("returns exception details without discarding ctx", async () => {
		const harness = createHostrunHarness();

		const failed = await harness.evaluate({
			code: "ctx.beforeThrow = 7; console.error('boom soon'); throw new TypeError('bad hostrun')",
		});
		const recovered = await harness.evaluate({ code: "ctx.beforeThrow" });

		expect(failed.details).toMatchObject({
			error: { name: "TypeError", message: "bad hostrun" },
			result: undefined,
			console: [{ level: "error", text: "boom soon" }],
		});
		expect(recovered.details.result).toBe(7);
	});

	it("blocks cli commands when approval is denied", async () => {
		const confirm = vi.fn().mockResolvedValue(false);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({
			code: "cli.node('-e', 'console.log(\"should-not-run\")').stdout.text()",
		});

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0]?.[0]).toContain("node");
		expect(result.details.error?.message).toContain("denied");
	});

	it("runs cli commands only after approval", async () => {
		const confirm = vi.fn().mockResolvedValue(true);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({ code: "cli.node('-e', 'console.log(\"hostrun-ok\")').stdout.text()" });

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(result.details.result).toBe("hostrun-ok\n");
	});

	it("does not write files when approval is denied", async () => {
		const target = join(tempDir, "blocked.txt");
		const confirm = vi.fn().mockResolvedValue(false);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({ code: `fs.write(${JSON.stringify(target)}, 'blocked')` });

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(result.details.error?.message).toContain("denied");
		expect(existsSync(target)).toBe(false);
	});

	it("reads and writes files only after approval", async () => {
		const target = join(tempDir, "allowed.txt");
		const confirm = vi.fn().mockResolvedValue(true);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({
			code: `fs.write(${JSON.stringify(target)}, 'allowed'); fs.read(${JSON.stringify(target)})`,
		});

		expect(confirm).toHaveBeenCalledTimes(2);
		expect(result.details.result).toBe("allowed");
		expect(readFileSync(target, "utf8")).toBe("allowed");
	});

	it("does not send HTTP requests when approval is denied", async () => {
		let requests = 0;
		const server = createServer((_request, response) => {
			requests++;
			response.end("blocked");
		});
		servers.push(server);
		const port = await listen(server);
		const confirm = vi.fn().mockResolvedValue(false);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({ code: `http.get('http://127.0.0.1:${port}/blocked').text()` });

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(result.details.error?.message).toContain("denied");
		expect(requests).toBe(0);
	});

	it("sends HTTP requests only after approval", async () => {
		let requests = 0;
		const server = createServer((_request, response) => {
			requests++;
			response.end("hostrun-http-ok");
		});
		servers.push(server);
		const port = await listen(server);
		const confirm = vi.fn().mockResolvedValue(true);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({ code: `http.get('http://127.0.0.1:${port}/allowed').text()` });

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(result.details.result).toBe("hostrun-http-ok");
		expect(requests).toBe(1);
	});
});
