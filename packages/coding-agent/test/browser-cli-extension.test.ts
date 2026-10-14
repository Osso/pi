import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import browserCliExtension, {
	type BrowserCliCommandRunner,
	createBrowserCliToolDefinition,
} from "../extensions/browser-cli/src/index.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";

const SESSION_KEY = "01a136c8-session:main";

function sessionContext(sessionId = "01a136c8-session", agentId?: string): ExtensionContext {
	return {
		sessionManager: { getSessionId: () => sessionId },
		toolExecutionAgentId: agentId,
	} as unknown as ExtensionContext;
}

describe("browser-cli extension", () => {
	let previousPath: string | undefined;
	const temporaryDirectories: string[] = [];

	afterEach(() => {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, { force: true, recursive: true });
		}
	});

	it("does not register browser-cli when the executable is unavailable", () => {
		previousPath = process.env.PATH;
		const emptyPath = mkdtempSync(join(tmpdir(), "pi-browser-cli-empty-path-"));
		temporaryDirectories.push(emptyPath);
		process.env.PATH = emptyPath;
		const registeredTools: string[] = [];

		browserCliExtension({
			registerTool: (tool: ToolDefinition) => registeredTools.push(tool.name),
		} as unknown as ExtensionAPI);

		expect(registeredTools).not.toContain("browser-cli");
	});

	it("registers browser-cli when the executable is available", () => {
		previousPath = process.env.PATH;
		const pathDirectory = mkdtempSync(join(tmpdir(), "pi-browser-cli-path-"));
		temporaryDirectories.push(pathDirectory);
		const executableName = process.platform === "win32" ? "browser-cli.CMD" : "browser-cli";
		const executablePath = join(pathDirectory, executableName);
		writeFileSync(executablePath, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
		if (process.platform !== "win32") chmodSync(executablePath, 0o755);
		process.env.PATH = pathDirectory;
		const registeredTools: string[] = [];

		browserCliExtension({
			registerTool: (tool: ToolDefinition) => registeredTools.push(tool.name),
		} as unknown as ExtensionAPI);

		expect(registeredTools).toContain("browser-cli");
	});

	it("runs an ordered browser-cli command batch and returns every result", async () => {
		const runCommand = vi
			.fn<BrowserCliCommandRunner>()
			.mockResolvedValueOnce({ stdout: "Clicked\n", stderr: "", exitCode: 0 })
			.mockResolvedValueOnce({ stdout: "Waited\n", stderr: "", exitCode: 0 })
			.mockResolvedValueOnce({ stdout: "Report ready\n", stderr: "", exitCode: 0 });
		const tool = createBrowserCliToolDefinition({ runCommand });

		const result = await tool.execute(
			"call-1",
			{
				commands: [
					["click", "[gc-testing-id='generate-report-btn']"],
					["wait", "3000"],
					["get", "text", "[gc-testing-id='reporting-screen']"],
				],
			},
			undefined,
			undefined,
			sessionContext(),
		);

		expect(runCommand.mock.calls).toEqual([
			["browser-cli", ["click", "[gc-testing-id='generate-report-btn']"], SESSION_KEY, undefined],
			["browser-cli", ["wait", "3000"], SESSION_KEY, undefined],
			["browser-cli", ["get", "text", "[gc-testing-id='reporting-screen']"], SESSION_KEY, undefined],
		]);
		expect(result.details).toEqual({
			commands: [
				{ args: ["click", "[gc-testing-id='generate-report-btn']"], stdout: "Clicked\n", stderr: "", exitCode: 0 },
				{ args: ["wait", "3000"], stdout: "Waited\n", stderr: "", exitCode: 0 },
				{
					args: ["get", "text", "[gc-testing-id='reporting-screen']"],
					stdout: "Report ready\n",
					stderr: "",
					exitCode: 0,
				},
			],
		});
		expect(result.content).toEqual([{ type: "text", text: "Clicked\nWaited\nReport ready\n" }]);
	});

	it("stops a command batch on the first nonzero exit", async () => {
		const runCommand = vi
			.fn<BrowserCliCommandRunner>()
			.mockResolvedValueOnce({ stdout: "Clicked\n", stderr: "", exitCode: 0 })
			.mockResolvedValueOnce({ stdout: "", stderr: "denied", exitCode: 7 });
		const tool = createBrowserCliToolDefinition({ runCommand });

		await expect(
			tool.execute(
				"call-2",
				{
					commands: [
						["click", "#search"],
						["wait", "3000"],
						["get", "title"],
					],
				},
				undefined,
				undefined,
				sessionContext(),
			),
		).rejects.toThrow(/browser-cli command 2.*7/);
		expect(runCommand).toHaveBeenCalledTimes(2);
	});

	it("rejects a running command when its signal is aborted", async () => {
		const runCommand = vi
			.fn<BrowserCliCommandRunner>()
			.mockImplementation(async (_executable, _args, _session, signal) => {
				await new Promise<void>((resolve) => {
					signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return { stdout: "late", stderr: "", exitCode: 0 };
			});
		const tool = createBrowserCliToolDefinition({ runCommand });
		const controller = new AbortController();
		const execution = tool.execute(
			"call-3",
			{
				commands: [
					["wait", "1000"],
					["get", "title"],
				],
			},
			controller.signal,
			undefined,
			sessionContext(),
		);

		controller.abort();

		await expect(execution).rejects.toThrow(/browser-cli command aborted/);
		expect(runCommand).toHaveBeenCalledTimes(1);
		expect(runCommand).toHaveBeenCalledWith("browser-cli", ["wait", "1000"], SESSION_KEY, controller.signal);
	});

	it("gives each agent of a session its own browser tab session key", async () => {
		const runCommand = vi.fn<BrowserCliCommandRunner>().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
		const tool = createBrowserCliToolDefinition({ runCommand });

		await tool.execute("call-a", { commands: [["get", "url"]] }, undefined, undefined, sessionContext("s1"));
		await tool.execute(
			"call-b",
			{ commands: [["get", "url"]] },
			undefined,
			undefined,
			sessionContext("s1", "agent_7"),
		);
		await tool.execute("call-c", { commands: [["get", "url"]] }, undefined, undefined, sessionContext("s2"));

		expect(runCommand.mock.calls.map((call) => call[2])).toEqual(["s1:main", "s1:agent_7", "s2:main"]);
	});

	it("fails instead of running browser-cli without a session ID", async () => {
		const runCommand = vi.fn<BrowserCliCommandRunner>();
		const tool = createBrowserCliToolDefinition({ runCommand });

		await expect(
			tool.execute("call-d", { commands: [["get", "url"]] }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow(/session ID/);
		expect(runCommand).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === "win32")(
		"passes the session to the spawned browser-cli and clears an inherited tab",
		async () => {
			previousPath = process.env.PATH;
			const pathDirectory = mkdtempSync(join(tmpdir(), "pi-browser-cli-env-"));
			temporaryDirectories.push(pathDirectory);
			const executablePath = join(pathDirectory, "browser-cli");
			writeFileSync(
				executablePath,
				'#!/bin/sh\nprintf "session=%s tab=%s args=%s" "$BROWSER_CLI_SESSION" "$BROWSER_CLI_TAB" "$*"\n',
			);
			chmodSync(executablePath, 0o755);
			process.env.PATH = pathDirectory;
			const previousTab = process.env.BROWSER_CLI_TAB;
			process.env.BROWSER_CLI_TAB = "SOMEONE-ELSES-TAB";
			try {
				const tool = createBrowserCliToolDefinition();
				const result = await tool.execute(
					"call-e",
					{ commands: [["get", "url"]] },
					undefined,
					undefined,
					sessionContext("s9", "agent_3"),
				);
				expect(result.content).toEqual([{ type: "text", text: "session=s9:agent_3 tab= args=get url" }]);
			} finally {
				if (previousTab === undefined) delete process.env.BROWSER_CLI_TAB;
				else process.env.BROWSER_CLI_TAB = previousTab;
			}
		},
	);

	it("documents parent routing, browser operation, and mapped broker authentication", () => {
		const tool = createBrowserCliToolDefinition();
		const guidelines = tool.promptGuidelines?.join("\n") ?? "";

		expect(guidelines).toContain('agentType "browser"');
		expect(guidelines).toContain("multi-step");
		expect(guidelines).toContain("snapshot");
		expect(guidelines).toContain("--current-origin");
		expect(guidelines).toContain("MFA");
	});
});
