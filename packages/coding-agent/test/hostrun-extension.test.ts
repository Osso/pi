import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

	it("runs cli.run only after approval and returns process details", async () => {
		const confirm = vi.fn().mockResolvedValue(true);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({ code: "cli.node('-e', 'console.log(\"cli-run-ok\")').run()" });

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(result.details.result).toMatchObject({
			exitCode: 0,
			stderr: "",
			stdout: "cli-run-ok\n",
		});
	});

	it("runs run helpers only after approval without captured output", async () => {
		const target = join(tempDir, "run-helper.txt");
		const confirm = vi.fn().mockResolvedValue(true);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({
			code: `run.node('-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(target)}, 'ran')`)})`,
		});

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(result.details.result).toBeUndefined();
		expect(readFileSync(target, "utf8")).toBe("ran");
	});

	it("does not run run helpers when approval is denied", async () => {
		const target = join(tempDir, "denied-run-helper.txt");
		const confirm = vi.fn().mockResolvedValue(false);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({
			code: `run.node('-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(target)}, 'ran')`)})`,
		});

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(result.details.error?.message).toContain("denied");
		expect(existsSync(target)).toBe(false);
	});

	it("gates fs.exists, fs.remove, and fs.glob", async () => {
		const first = join(tempDir, "first.txt");
		const second = join(tempDir, "second.txt");
		writeFileSync(first, "first");
		writeFileSync(second, "second");
		const confirm = vi.fn().mockResolvedValue(true);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({
			code: [
				`const before = fs.exists(${JSON.stringify(first)});`,
				`const files = fs.glob(${JSON.stringify(`${tempDir}/*.txt`)});`,
				`fs.remove(${JSON.stringify(first)});`,
				`({ before, after: fs.exists(${JSON.stringify(first)}), files: files.sort() })`,
			].join("\n"),
		});

		expect(confirm).toHaveBeenCalledTimes(4);
		expect(result.details.result).toEqual({
			after: false,
			before: true,
			files: [first, second],
		});
		expect(existsSync(first)).toBe(false);
		expect(existsSync(second)).toBe(true);
	});

	it("supports approval-gated fs.glob options", async () => {
		const first = join(tempDir, "first.txt");
		const nested = join(tempDir, "nested");
		mkdirSync(nested);
		writeFileSync(first, "first");
		writeFileSync(join(nested, "second.txt"), "second");
		const confirm = vi.fn().mockResolvedValue(true);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({
			code: `fs.glob('*.txt', { cwd: ${JSON.stringify(tempDir)} }).sort()`,
		});

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(result.details.result).toEqual(["first.txt"]);
	});

	it("parses JSON, JSONL, and CSV files through approval-gated fs.open", async () => {
		const jsonPath = join(tempDir, "data.json");
		const jsonlPath = join(tempDir, "events.jsonl");
		const csvPath = join(tempDir, "scores.csv");
		writeFileSync(jsonPath, '{"enabled":true,"count":2}');
		writeFileSync(jsonlPath, '{"id":1}\n{"id":2}\n');
		writeFileSync(csvPath, "name,score\nAda,10\nLin,9\n");
		const confirm = vi.fn().mockResolvedValue(true);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({
			code: [
				`const json = fs.open(${JSON.stringify(jsonPath)});`,
				`const jsonl = fs.open(${JSON.stringify(jsonlPath)});`,
				`const csv = fs.open(${JSON.stringify(csvPath)}, { format: 'csv' });`,
				`({ json, jsonl, csv })`,
			].join("\n"),
		});

		expect(confirm).toHaveBeenCalledTimes(3);
		expect(result.details.result).toEqual({
			csv: [
				{ name: "Ada", score: "10" },
				{ name: "Lin", score: "9" },
			],
			json: { count: 2, enabled: true },
			jsonl: [{ id: 1 }, { id: 2 }],
		});
	});

	it("does not remove files when fs.remove approval is denied", async () => {
		const target = join(tempDir, "keep.txt");
		writeFileSync(target, "keep");
		const confirm = vi.fn().mockResolvedValue(false);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({ code: `fs.remove(${JSON.stringify(target)})` });

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(result.details.error?.message).toContain("denied");
		expect(readFileSync(target, "utf8")).toBe("keep");
	});

	it("posts HTTP bodies only after approval and redacts auth metadata", async () => {
		let requestBody = "";
		let authorizationHeader = "";
		const server = createServer((request, response) => {
			authorizationHeader = request.headers.authorization ?? "";
			request.on("data", (chunk: Buffer) => {
				requestBody += chunk.toString("utf8");
			});
			request.on("end", () => {
				response.end("posted");
			});
		});
		servers.push(server);
		const port = await listen(server);
		const confirm = vi.fn().mockResolvedValue(true);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({
			code: [
				`http.post('http://127.0.0.1:${port}/submit', {`,
				`  headers: { authorization: 'Bearer super-secret-token' },`,
				`  body: 'payload'`,
				`}).text()`,
			].join("\n"),
		});
		const approvalMessage = confirm.mock.calls[0]?.[1] ?? "";

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(approvalMessage).not.toContain("super-secret-token");
		expect(approvalMessage).toContain("[redacted]");
		expect(result.details.result).toBe("posted");
		expect(requestBody).toBe("payload");
		expect(authorizationHeader).toBe("Bearer super-secret-token");
	});

	it("supports approval-gated HTTP put, patch, delete, and head helpers", async () => {
		const requests: Array<{ body: string; method: string; url: string | undefined }> = [];
		const server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk: Buffer) => {
				body += chunk.toString("utf8");
			});
			request.on("end", () => {
				requests.push({ body, method: request.method ?? "", url: request.url });
				response.end(request.method === "HEAD" ? undefined : `${request.method} ok`);
			});
		});
		servers.push(server);
		const port = await listen(server);
		const confirm = vi.fn().mockResolvedValue(true);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({
			code: [
				`const base = 'http://127.0.0.1:${port}';`,
				`const put = http.put(base + '/put', { body: 'put-body' }).text();`,
				`const patch = http.patch(base + '/patch', { body: 'patch-body' }).text();`,
				`const deleted = http.delete(base + '/delete').text();`,
				`const head = http.head(base + '/head').text();`,
				`({ put, patch, deleted, head })`,
			].join("\n"),
		});

		expect(confirm).toHaveBeenCalledTimes(4);
		expect(result.details.result).toEqual({
			deleted: "DELETE ok",
			head: "",
			patch: "PATCH ok",
			put: "PUT ok",
		});
		expect(requests).toEqual([
			{ body: "put-body", method: "PUT", url: "/put" },
			{ body: "patch-body", method: "PATCH", url: "/patch" },
			{ body: "", method: "DELETE", url: "/delete" },
			{ body: "", method: "HEAD", url: "/head" },
		]);
	});

	it("does not send HTTP posts when approval is denied", async () => {
		let requests = 0;
		const server = createServer((_request, response) => {
			requests++;
			response.end("blocked");
		});
		servers.push(server);
		const port = await listen(server);
		const confirm = vi.fn().mockResolvedValue(false);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({
			code: `http.post('http://127.0.0.1:${port}/blocked', { body: 'payload' }).text()`,
		});

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(result.details.error?.message).toContain("denied");
		expect(requests).toBe(0);
	});

	it("persists host.cwd and resolves relative paths after host.cd", async () => {
		const relativePath = join(tempDir, "relative.txt");
		writeFileSync(relativePath, "from-relative");
		const confirm = vi.fn().mockResolvedValue(true);
		const harness = createHostrunHarness({ confirm });

		const first = await harness.evaluate({
			code: [
				`const original = host.cwd();`,
				`host.cd(${JSON.stringify(tempDir)});`,
				`({ original, current: host.cwd(), text: fs.read('relative.txt') })`,
			].join("\n"),
			session_id: "cwd-test",
		});
		const second = await harness.evaluate({ code: "host.cwd()", session_id: "cwd-test" });

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(first.details.result).toEqual({
			current: tempDir,
			original: process.cwd(),
			text: "from-relative",
		});
		expect(second.details.result).toBe(tempDir);
	});

	it("gates rg.search, rg.files, and rg.matches", async () => {
		const first = join(tempDir, "first.txt");
		const second = join(tempDir, "second.txt");
		writeFileSync(first, "alpha\nbeta\n");
		writeFileSync(second, "alpha\n");
		const confirm = vi.fn().mockResolvedValue(true);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({
			code: [
				`const search = rg.search('alpha', ${JSON.stringify(tempDir)}).text();`,
				`const files = rg.files(${JSON.stringify(tempDir)}).lines().sort();`,
				`const matches = rg.matches('alpha', ${JSON.stringify(tempDir)});`,
				`({ search, files, matches })`,
			].join("\n"),
		});

		expect(confirm).toHaveBeenCalledTimes(3);
		expect(result.details.result).toMatchObject({
			files: [first, second],
			matches: [
				{ line: "alpha", lineNumber: 1, path: first },
				{ line: "alpha", lineNumber: 1, path: second },
			],
		});
		expect((result.details.result as { search: string }).search).toContain("alpha");
	});

	it("does not run rg wrappers when approval is denied", async () => {
		writeFileSync(join(tempDir, "blocked.txt"), "blocked");
		const confirm = vi.fn().mockResolvedValue(false);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({ code: `rg.search('blocked', ${JSON.stringify(tempDir)}).text()` });

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(result.details.error?.message).toContain("denied");
	});

	it("gates fd.find, fd.files, and fd.dirs", async () => {
		const nested = join(tempDir, "nested");
		const deeper = join(nested, "deeper");
		mkdirSync(deeper, { recursive: true });
		const first = join(tempDir, "first.txt");
		const second = join(nested, "second.txt");
		writeFileSync(first, "first");
		writeFileSync(second, "second");
		const confirm = vi.fn().mockResolvedValue(true);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({
			code: [
				`const found = fd.find('*.txt', ${JSON.stringify(tempDir)}).lines().sort();`,
				`const files = fd.files(${JSON.stringify(tempDir)}).sort();`,
				`const dirs = fd.dirs(${JSON.stringify(tempDir)}).sort();`,
				`({ found, files, dirs })`,
			].join("\n"),
		});

		expect(confirm).toHaveBeenCalledTimes(3);
		expect(result.details.result).toEqual({
			dirs: [nested, deeper],
			files: [first, second],
			found: [first, second],
		});
	});

	it("does not run fd wrappers when approval is denied", async () => {
		writeFileSync(join(tempDir, "blocked.txt"), "blocked");
		const confirm = vi.fn().mockResolvedValue(false);
		const harness = createHostrunHarness({ confirm });

		const result = await harness.evaluate({ code: `fd.files(${JSON.stringify(tempDir)})` });

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(result.details.error?.message).toContain("denied");
	});
});
