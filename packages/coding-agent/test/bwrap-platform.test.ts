import * as childProcess from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createBwrapRunnerCommand,
	createSandboxedBashOperations,
	runBwrapAvailabilityCheck,
} from "../extensions/bwrap/src/backend.ts";
import bwrapExtension from "../extensions/bwrap/src/index.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type {
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	ToolGate,
} from "../src/index.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function requireRegistration<T>(value: T | undefined, registration: string): T {
	if (value === undefined) throw new Error(`Expected bwrap registration: ${registration}`);
	return value;
}

function createHarness(cwd: string, profile?: "full-access" | "read-only" | "workspace-write") {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const tools = new Map<string, ToolDefinition>();
	const gates: ToolGate[] = [];
	const notify = vi.fn();
	const setStatus = vi.fn();
	const ctx = {
		cwd,
		settingsManager: SettingsManager.inMemory(profile ? { sandboxProfile: profile } : {}),
		ui: { notify, setStatus, theme: { fg: (_color: string, text: string) => text } },
	} as unknown as ExtensionContext;
	bwrapExtension(
		{
			on: (name: string, handler: Handler) => handlers.set(name, handler),
			registerCommand: (
				name: string,
				command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
			) => commands.set(name, command),
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
			registerToolGate: (gate: ToolGate) => gates.push(gate),
		} as unknown as ExtensionAPI,
		{ bwrapCommand: "mock-bwrap" },
	);
	return {
		ctx,
		notify,
		setStatus,
		tool: (name: string) => requireRegistration(tools.get(name), `tool ${name}`),
		event: (name: string) => requireRegistration(handlers.get(name), `event ${name}`),
		command: (name: string) => requireRegistration(commands.get(name), `command /${name}`),
		gate: () => requireRegistration(gates[0], "tool gate 0"),
	};
}

describe("bubblewrap platform capability", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-bwrap-platform-"));
		vi.stubGlobal("process", Object.create(process, { platform: { value: "darwin" } }));
		vi.mocked(childProcess.spawnSync).mockReturnValue({
			status: 0,
			stdout: "bubblewrap 0.11",
			stderr: "",
			pid: 1,
			output: [null, "bubblewrap 0.11", ""],
			signal: null,
		});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.mocked(childProcess.spawnSync).mockReset();
		rmSync(cwd, { recursive: true, force: true });
	});

	it.each([undefined, "full-access"] as const)(
		"allows real local file operations on Darwin with profile %s without probing bwrap",
		async (profile) => {
			const harness = createHarness(cwd, profile);
			const file = join(cwd, "local.txt");
			writeFileSync(file, "local read\n");
			const result = await harness
				.tool("read")
				.execute("read-local", { path: file }, undefined, undefined, harness.ctx);
			expect(result.content).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "text", text: expect.stringContaining("local read") }),
				]),
			);
			await harness
				.tool("write")
				.execute("write-local", { path: file, content: "local write\n" }, undefined, undefined, harness.ctx);
			expect(readFileSync(file, "utf8")).toBe("local write\n");
			const bashOutput: string[] = [];
			const bash = createSandboxedBashOperations({
				bwrapCommand: "mock-bwrap",
				profile: undefined,
				shellPath: "/bin/sh",
			});
			expect(
				await bash.exec("printf local-bash", cwd, { onData: (chunk) => bashOutput.push(chunk.toString()) }),
			).toEqual({ exitCode: 0 });
			expect(bashOutput.join("")).toBe("local-bash");
			expect(
				await harness.gate()(
					{
						type: "tool_call",
						toolName: "read",
						toolCallId: "local",
						input: { path: file },
						bypassPermissions: false,
					},
					harness.ctx,
				),
			).toBeUndefined();
			await harness.event("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
			expect(harness.setStatus).toHaveBeenCalledWith("bwrap", expect.stringContaining("full access"));
			expect(childProcess.spawnSync).not.toHaveBeenCalled();
		},
	);

	it.each(["read-only", "workspace-write"] as const)(
		"blocks %s on Darwin even when the command boundary would succeed",
		async (profile) => {
			const harness = createHarness(cwd, profile);
			const file = join(cwd, "denied.txt");
			const result = await harness.gate()(
				{
					type: "tool_call",
					toolName: "write",
					toolCallId: "denied",
					input: { path: file, content: "unsafe" },
					bypassPermissions: false,
				},
				harness.ctx,
			);
			expect(result).toMatchObject({ block: true, reason: expect.stringMatching(/unsupported.*darwin.*Linux/i) });
			await expect(
				harness
					.tool("write")
					.execute("denied", { path: file, content: "unsafe" }, undefined, undefined, harness.ctx),
			).rejects.toThrow(/unsupported.*darwin.*Linux/i);
			expect(existsSync(file)).toBe(false);
			expect(childProcess.spawnSync).not.toHaveBeenCalled();
		},
	);

	it("reports unsupported Darwin status at startup, in /bwrap, and in model context", async () => {
		const harness = createHarness(cwd, "read-only");
		await harness.event("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.setStatus).toHaveBeenCalledWith("bwrap", expect.stringContaining("unsupported on darwin"));
		expect(harness.notify).toHaveBeenCalledWith(expect.stringMatching(/unsupported.*darwin.*Linux/i), "error");
		await harness.command("bwrap").handler("", harness.ctx);
		expect(harness.notify).toHaveBeenLastCalledWith(expect.stringMatching(/unsupported.*darwin.*Linux/is), "error");
		const result = (await harness.event("before_agent_start")(
			{ systemPrompt: `Current working directory: ${cwd}` },
			harness.ctx,
		)) as BeforeAgentStartEventResult;
		expect(result.systemPrompt).toMatch(/unsupported.*darwin.*tools.*blocked/is);
		expect(result.systemPrompt).not.toContain("Pyrun executes inside the sandbox");
	});

	it("rejects sandboxed user bash and runner commands on Darwin before native execution", async () => {
		const bash = createSandboxedBashOperations({ bwrapCommand: "mock-bwrap", profile: "read-only" });
		await expect(bash.exec("printf unsafe", cwd, { onData: () => {} })).rejects.toThrow(
			/unsupported.*darwin.*Linux/i,
		);
		expect(() =>
			createBwrapRunnerCommand({
				bwrapCommand: "mock-bwrap",
				cwd,
				profile: "workspace-write",
				runnerCommand: "runner",
				runnerArgs: [],
			}),
		).toThrow(/unsupported.*darwin.*Linux/i);
		expect(childProcess.spawnSync).not.toHaveBeenCalled();
	});

	it("reports missing Linux bwrap as blocked rather than sandboxed in /bwrap", async () => {
		vi.stubGlobal("process", Object.create(process, { platform: { value: "linux" } }));
		vi.mocked(childProcess.spawnSync).mockReturnValue({
			status: null,
			stdout: "",
			stderr: "",
			pid: 0,
			output: [],
			signal: null,
			error: new Error("ENOENT"),
		});
		const harness = createHarness(cwd, "read-only");
		await harness.command("bwrap").handler("", harness.ctx);
		expect(harness.notify).toHaveBeenLastCalledWith(
			expect.stringMatching(/unavailable.*ENOENT.*tools blocked/is),
			"error",
		);
	});

	it("retains Linux availability checking and missing-command failure", () => {
		vi.stubGlobal("process", Object.create(process, { platform: { value: "linux" } }));
		expect(() => runBwrapAvailabilityCheck("mock-bwrap")).not.toThrow();
		expect(childProcess.spawnSync).toHaveBeenCalledWith("mock-bwrap", ["--version"], { encoding: "utf8" });
		vi.mocked(childProcess.spawnSync).mockReturnValue({
			status: null,
			stdout: "",
			stderr: "",
			pid: 0,
			output: [],
			signal: null,
			error: new Error("ENOENT"),
		});
		expect(() => runBwrapAvailabilityCheck("mock-bwrap")).toThrow(/bubblewrap.*required.*unavailable.*ENOENT/i);
	});
});
