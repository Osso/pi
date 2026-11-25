import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { createHeadlessPaths, createProviderServer, runWithCleanup } from "../headless-pi.ts";

interface ShutdownRun {
	exitCode: number | null;
	cleanupFinished: boolean;
	stdout: string;
	stderr: string;
}

function waitForRpcReady(proc: ChildProcess, stderr: () => string): Promise<void> {
	let stdout = "";
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`RPC mode did not start: ${stderr()}`)), 20_000);
		proc.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			if (stdout.includes('"id":"ready"')) {
				clearTimeout(timer);
				resolve();
			}
		});
		proc.stdin?.write(`${JSON.stringify({ id: "ready", type: "get_state" })}\n`);
	});
}

/**
 * Start pi with a `session_shutdown` handler that takes one second. In RPC mode, wait until it answers a command.
 * Then apply `trigger` to the live process, e.g. close stdin and send SIGTERM in the same tick, as Paseo does.
 */
async function runShutdown(
	modeArgs: string[],
	trigger: (child: ChildProcess, cleanupStarted: string, cleanupFinished: string) => void | Promise<void>,
	extensionCode: { startup?: string; shutdown?: string } = {},
	awaitRpcReady = true,
): Promise<ShutdownRun> {
	const paths = createHeadlessPaths();
	const cacheDir = join(paths.tempDir, "compile-cache");
	mkdirSync(cacheDir);
	const startedMarker = join(paths.tempDir, "cleanup-started");
	const finishedMarker = join(paths.tempDir, "cleanup-finished");
	const extensionPath = join(paths.tempDir, "slow-shutdown.ts");
	writeFileSync(
		extensionPath,
		`import { writeFileSync } from "node:fs";
		export default function (pi) {
			pi.on("session_shutdown", async () => {
				${extensionCode.shutdown ?? ""}
				writeFileSync(${JSON.stringify(startedMarker)}, "started");
				await new Promise((resolve) => setTimeout(resolve, 1000));
				writeFileSync(${JSON.stringify(finishedMarker)}, "done");
			});
			${extensionCode.startup ?? ""}
		}`,
	);
	let child: ChildProcess | undefined;
	let childClosed: Promise<number | null> | undefined;
	let provider: Awaited<ReturnType<typeof createProviderServer>> | undefined;
	return runWithCleanup(
		async () => {
			provider = await createProviderServer(paths.socketPath, (request) => {
				const message = fauxAssistantMessage(
					[{ type: "text", text: "Done." }, fauxToolCall("end_turn", { reason: "done" })],
					{ stopReason: "toolUse" },
				);
				provider?.getSocket()?.write(`${JSON.stringify({ type: "response", requestId: request.id, message })}\n`);
			});
			const cliPath = join(import.meta.dirname, "..", "..", "..", "src", "cli.ts");
			const preloadPath = join(import.meta.dirname, "..", "fixtures", "headless-pi-provider-preload.ts");
			const proc = spawn(
				"node",
				[
					"--experimental-strip-types",
					"--import",
					pathToFileURL(preloadPath).href,
					cliPath,
					"--provider",
					"headless-faux",
					"--model",
					"headless-faux-1",
					"--no-session",
					"--no-context-files",
					"--no-skills",
					"--no-themes",
					"--no-extensions",
					"--extension",
					extensionPath,
					...modeArgs,
				],
				{
					cwd: paths.workspaceDir,
					env: {
						...process.env,
						NODE_COMPILE_CACHE: cacheDir,
						PI_CODING_AGENT_DIR: paths.agentDir,
						PI_CODING_AGENT_STATE_DIR: paths.agentDir,
						PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
						PI_HEADLESS_PROVIDER_SOCKET: paths.socketPath,
					},
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			child = proc;
			let stdout = "";
			let stderr = "";
			proc.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			proc.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			const exited = new Promise<number | null>((resolve) => proc.once("close", resolve));
			childClosed = exited;
			if (modeArgs.includes("rpc") && awaitRpcReady) await waitForRpcReady(proc, () => stderr);
			await trigger(proc, startedMarker, finishedMarker);
			const exitCode = await exited;
			return { exitCode, cleanupFinished: existsSync(finishedMarker), stdout, stderr };
		},
		async () => {
			if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			child?.stdout?.resume();
			if (childClosed) await childClosed;
			provider?.getSocket()?.destroy();
			if (provider)
				await new Promise<void>((resolve, reject) =>
					provider?.server.close((error) => (error ? reject(error) : resolve())),
				);
			rmSync(paths.tempDir, { recursive: true, force: true });
		},
	);
}

describe("shutdown signals during cleanup (#11752)", () => {
	it("lets an RPC shutdown started by stdin EOF finish when SIGTERM follows", async () => {
		// SIGTERM sent in the same tick as EOF can reach the child first; that order is the SIGTERM-first case below.
		const run = await runShutdown(["--mode", "rpc"], async (child, cleanupStarted) => {
			child.stdin?.end();
			await vi.waitFor(() => expect(existsSync(cleanupStarted)).toBe(true), { timeout: 20_000, interval: 20 });
			child.kill("SIGTERM");
		});

		expect(run.cleanupFinished, run.stderr).toBe(true);
		expect(run.exitCode).toBe(0);
	}, 60_000);

	it("lets an RPC shutdown started by SIGTERM finish when stdin closes next", async () => {
		const run = await runShutdown(["--mode", "rpc"], (child) => {
			child.kill("SIGTERM");
			setTimeout(() => child.stdin?.end(), 100);
		});

		expect(run.cleanupFinished, run.stderr).toBe(true);
		expect(run.exitCode).toBe(143);
	}, 60_000);

	it("cancels a startup dialog opened after stdin closed and finishes RPC shutdown", async () => {
		const run = await runShutdown(
			["--mode", "rpc"],
			async (child) => {
				let stdout = "";
				child.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
				});
				await vi.waitFor(() => expect(stdout).toContain("First startup confirmation"), {
					timeout: 20_000,
					interval: 20,
				});
				child.stdin?.end();
			},
			{
				startup: `pi.on("session_start", async (_event, ctx) => {
					await ctx.ui.confirm("First startup confirmation", "Proceed?");
					await ctx.ui.confirm("Second startup confirmation", "Proceed again?");
				});`,
			},
			false,
		);

		expect(run.cleanupFinished, run.stderr).toBe(true);
		expect(run.exitCode).toBe(0);
	}, 30_000);

	it("exits RPC mode at once on a repeated signal", async () => {
		const run = await runShutdown(["--mode", "rpc"], (child) => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGTERM"), 100);
		});

		expect(run.cleanupFinished).toBe(false);
		expect(run.exitCode).toBe(143);
	}, 60_000);

	it("lets print mode's final disposal finish when SIGTERM arrives during it", async () => {
		const run = await runShutdown(["-p", "hi"], async (child, cleanupStarted) => {
			child.stdin?.end();
			await vi.waitFor(() => expect(existsSync(cleanupStarted)).toBe(true), { timeout: 20_000, interval: 20 });
			child.kill("SIGTERM");
		});

		expect(run.cleanupFinished, run.stderr).toBe(true);
		expect(run.exitCode).toBe(143);
	}, 60_000);

	it.each([
		["writes complete JSONL when SIGTERM arrives under stdout backpressure", false],
		["exits promptly on repeated SIGTERM under stdout backpressure", true],
	])(
		"%s",
		async (_scenario, repeatSignal) => {
			const payloadPart = "known-shutdown-payload:";
			const repetitions = 65_536;
			const expectedPayload = payloadPart.repeat(repetitions);
			const run = await runShutdown(
				["--mode", "json"],
				async (child, cleanupStarted, cleanupFinished) => {
					child.stdout?.pause();
					child.stdin?.end();
					await vi.waitFor(() => expect(existsSync(cleanupStarted)).toBe(true), {
						timeout: 20_000,
						interval: 20,
					});
					child.kill("SIGTERM");
					await vi.waitFor(() => expect(existsSync(cleanupFinished)).toBe(true), {
						timeout: 20_000,
						interval: 20,
					});
					if (repeatSignal) {
						expect(child.exitCode).toBeNull();
						child.kill("SIGTERM");
						await vi.waitFor(() => expect(child.exitCode).toBe(143), { timeout: 5_000 });
					}
					child.stdout?.resume();
				},
				{ shutdown: `pi.appendEntry("shutdown-payload", ${JSON.stringify(payloadPart)}.repeat(${repetitions}));` },
			);

			expect(run.cleanupFinished, run.stderr).toBe(true);
			expect(run.exitCode).toBe(143);
			if (repeatSignal) return;

			expect(run.stdout.endsWith("\n")).toBe(true);
			const lines = run.stdout.split("\n");
			const output = lines.slice(0, -1).map(
				(line) =>
					JSON.parse(line) as {
						type: string;
						entry?: { customType?: string; data?: string };
					},
			);
			const payloadEvent = output.find(
				(line) => line.type === "entry_appended" && line.entry?.customType === "shutdown-payload",
			);

			expect(payloadEvent?.entry?.data?.length).toBe(expectedPayload.length);
			expect(payloadEvent?.entry?.data === expectedPayload).toBe(true);
		},
		60_000,
	);
});

describe("idle RPC shutdown requests (#11746)", () => {
	it("shuts down when an extension calls ctx.shutdown() while the session is idle", async () => {
		const run = await runShutdown(
			["--mode", "rpc"],
			(child) => {
				child.stdin?.write(`${JSON.stringify({ type: "prompt", message: "/shutdown-later" })}\n`);
			},
			{
				startup: `pi.registerCommand("shutdown-later", {
					description: "Request shutdown from a timer",
					handler: async (_args, ctx) => {
						setTimeout(() => ctx.shutdown(), 300);
					},
				});`,
			},
		);

		expect(run.cleanupFinished, run.stderr).toBe(true);
		expect(run.exitCode).toBe(0);
	}, 30_000);
});
