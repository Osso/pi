import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import { getControlDbPath, readSessionMetadata } from "../../../src/core/session-control-db.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHeadlessPaths } from "../headless-pi.ts";
import { startHeadlessSupervisorProbe } from "../fixtures/headless-supervisor-probe.ts";

interface Observation {
	sessionId: string;
	modelId: string;
	provider: string;
	reasoning?: string;
	pid: number;
}
interface Request extends Observation {
	id: string;
	messages: Message[];
	socket: Socket;
}
interface Startup {
	sessionId: string;
	sessionFile: string;
	pid: number;
}

function readRecords<T>(path: string): T[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as T);
}

async function waitFor<T>(read: () => T | undefined, label: string, output: () => string): Promise<T> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for ${label}: ${output().slice(-6000)}`);
}

async function stopBridge(bridge: ChildProcessWithoutNullStreams): Promise<void> {
	if (bridge.exitCode !== null || bridge.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => bridge.once("close", () => resolve()));
	bridge.kill("SIGTERM");
	const stopped = await Promise.race([
		exited.then(() => true),
		new Promise<false>((resolve) => setTimeout(() => resolve(false), 2500)),
	]);
	if (!stopped) bridge.kill("SIGKILL");
	await exited;
}

interface ModelConfig {
	id: string;
	name: string;
	reasoning?: boolean;
	input: string[];
	cost: Record<string, number>;
	contextWindow: number;
	maxTokens: number;
}
interface ProviderConfig {
	api: string;
	apiKey: string;
	baseUrl: string;
	models: ModelConfig[];
}

function writeRestartFixture() {
	const paths = createHeadlessPaths();
	const observationsPath = join(paths.tempDir, "observations.jsonl");
	const startupsPath = join(paths.tempDir, "startups.jsonl");
	const bootsPath = join(paths.tempDir, "boots.jsonl");
	const preloadPath = join(paths.tempDir, "observe.mjs");
	const extensionPath = join(paths.tempDir, "selection.mjs");
	const modelA = "headless-faux-reasoning";
	const modelB = "runtime-reasoning-b";
	const modelC = "headless-faux-1";
	const modelsPath = join(paths.agentDir, "models.json");
	const models = JSON.parse(readFileSync(modelsPath, "utf8")) as { providers: Record<string, ProviderConfig> };
	models.providers["runtime-faux"] = { ...models.providers["headless-faux"], models: [] };
	models.providers["runtime-faux"].models.push({
		...models.providers["headless-faux"].models[1],
		id: modelB,
		name: "Runtime B",
	});
	writeFileSync(modelsPath, JSON.stringify(models));
	writeFileSync(
		join(paths.agentDir, "settings.json"),
		JSON.stringify({
			approvalPolicy: "auto-approve",
			approvalPreset: "auto-approve",
			disabledExtensions: ["claude-memory-enrich", "effort", "session-autoname"],
			agents: { explore: { model: `headless-faux/${modelC}`, thinkingLevel: "off" } },
		}),
	);
	writeFileSync(
		preloadPath,
		`
import ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "fixtures", "interactive-pty-provider-preload.ts")).href)};
import { appendFileSync } from "node:fs";
import { getApiProvider, registerApiProvider } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/compat"))};
const provider = getApiProvider("headless-faux");
appendFileSync(${JSON.stringify(bootsPath)}, JSON.stringify({pid: process.pid}) + "\\n");
function observe(stream) {
 return (model, context, options) => {
  appendFileSync(${JSON.stringify(observationsPath)}, JSON.stringify({sessionId: options?.sessionId, modelId: model.id, provider: model.provider, reasoning: options?.reasoning, pid: process.pid}) + "\\n");
  return stream(model, context, options);
 };
}
registerApiProvider({ api: provider.api, stream: observe(provider.stream), streamSimple: observe(provider.streamSimple) });
globalThis.interactivePtyFauxProvider = getApiProvider("headless-faux");
`,
	);
	writeFileSync(
		extensionPath,
		`
import { appendFileSync, readFileSync } from "node:fs";
export default function(pi) {
 const provider = globalThis.interactivePtyFauxProvider;
 const configs = JSON.parse(readFileSync(${JSON.stringify(modelsPath)}, "utf8")).providers;
 for (const [name, config] of Object.entries(configs)) pi.registerProvider(name, { ...config, streamSimple: provider.streamSimple });
 pi.on("session_start", (_event, ctx) => {
  appendFileSync(${JSON.stringify(startupsPath)}, JSON.stringify({sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), pid: process.pid}) + "\\n");
 });
 pi.registerCommand("select-runtime-b", { description: "Set explicit runtime model and thinking", handler: async (_args, ctx) => {
  const model = ctx.modelRegistry.find("runtime-faux", ${JSON.stringify(modelB)});
  if (!model || !await ctx.setModel(model)) throw new Error("Cannot select runtime B");
  ctx.setThinkingLevel("high");
  ctx.ui.notify("runtime-b-selected", "info");
 }});
}
`,
	);
	return { paths, observationsPath, startupsPath, bootsPath, preloadPath, extensionPath, modelA, modelB, modelC };
}

function startProviderTransport(observationsPath: string) {
	const requests: Request[] = [];
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "ECONNRESET") throw error;
		});
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			while (buffer.includes("\n")) {
				const index = buffer.indexOf("\n");
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (!line) continue;
				const wire = JSON.parse(line) as { id: string; sessionId: string; messages: Message[] };
				const observation = readRecords<Observation>(observationsPath).findLast(
					(entry) => entry.sessionId === wire.sessionId,
				);
				if (!observation) throw new Error("Missing actual provider observation");
				requests.push({ ...observation, ...wire, socket });
			}
		});
	});
	return { requests, sockets, server };
}

function spawnInteractiveCli(fixture: ReturnType<typeof writeRestartFixture>) {
	const { paths, preloadPath, extensionPath, modelA } = fixture;
	return spawn(
		"python3",
		[
			join(import.meta.dirname, "..", "fixtures", "interactive-pty-bridge.py"),
			"24",
			"100",
			process.execPath,
			"--experimental-strip-types",
			join(import.meta.dirname, "..", "..", "..", "src", "cli.ts"),
			"--approve",
			"--provider",
			"headless-faux",
			"--model",
			modelA,
			"--thinking",
			"low",
			"--session-dir",
			paths.sessionDir,
			"--no-context-files",
			"--no-skills",
			"--no-themes",
			"--extension",
			extensionPath,
		],
		{
			cwd: paths.workspaceDir,
			env: {
				...process.env,
				NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
				NODE_COMPILE_CACHE: join(paths.tempDir, "cache"),
				PI_CODING_AGENT_DIR: paths.agentDir,
				PI_CODING_AGENT_STATE_DIR: paths.agentDir,
				PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
				PI_HEADLESS_PROVIDER_SOCKET: paths.socketPath,
				TERM: "xterm-256color",
				NO_COLOR: "1",
				PI_TUI_WRITE_LOG: "",
				PI_TUI_DEBUG: "0",
			},
		},
	);
}

it.skipIf(process.platform === "win32").each([true, false])(
	"preserves actual parent selection across interactive process restart with a live profile child (runtime change=%s)",
	async (changeSelection) => {
		const fixture = writeRestartFixture();
		const { paths, startupsPath, modelA, modelB, modelC } = fixture;
		const { requests, sockets, server } = startProviderTransport(fixture.observationsPath);
		let bridge: ChildProcessWithoutNullStreams | undefined;
		let probe: Awaited<ReturnType<typeof startHeadlessSupervisorProbe>> | undefined;
		let output = "";
		try {
			probe = await startHeadlessSupervisorProbe(getControlDbPath(paths.agentDir));
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(paths.socketPath, resolve);
			});
			bridge = spawnInteractiveCli(fixture);
			bridge.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			bridge.stderr.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			const startup = await waitFor(
				() => readRecords<Startup>(startupsPath)[0],
				"initial startup",
				() => output,
			);
			await waitFor(
				() => (output.includes(modelA) ? true : undefined),
				"editor",
				() => output,
			);
			if (changeSelection) {
				bridge.stdin.write("/select-runtime-b\r");
				await waitFor(
					() => (output.includes("runtime-b-selected") ? true : undefined),
					"runtime selection",
					() => output,
				);
			}
			bridge.stdin.write("Spawn a live explore child then restart this supervisor\r");
			const parent = await waitFor(
				() => requests.find((request) => request.sessionId === startup.sessionId),
				"parent request",
				() => output,
			);
			const expected = {
				modelId: changeSelection ? modelB : modelA,
				provider: changeSelection ? "runtime-faux" : "headless-faux",
				reasoning: changeSelection ? "high" : "low",
			};
			expect(parent).toMatchObject(expected);
			parent.socket.write(
				`${JSON.stringify({
					type: "response",
					requestId: parent.id,
					message: fauxAssistantMessage(
						fauxToolCall("spawn_agent", {
							agentType: "explore",
							context: "fresh",
							displayName: "Restart profile child C",
							prompt: "CHILD_C_ASSIGNMENT: remain live across supervisor process restart",
						}),
						{ stopReason: "toolUse" },
					),
				})}\n`,
			);
			const childRequest = await waitFor(
				() => requests.find((request) => request.sessionId && request.sessionId !== startup.sessionId),
				"child C request",
				() => output,
			);
			expect(childRequest).toMatchObject({ modelId: modelC, provider: "headless-faux" });
			const session = SessionManager.open(startup.sessionFile);
			session.setMetadataControlDbPath(getControlDbPath(paths.agentDir));
			const store = MultiAgentStore.fromSessionManager(session);
			const child = await waitFor(
				() =>
					store
						.listAgents()
						.find((agent) => agent.displayName === "Restart profile child C" && agent.lifecycle === "running"),
				"live child assignment",
				() => output,
			);
			const afterSpawn = await waitFor(
				() => requests.find((request) => request.sessionId === startup.sessionId && request !== parent),
				"parent after spawn",
				() => output,
			);
			expect(afterSpawn).toMatchObject(expected);
			const requestCount = requests.length;
			afterSpawn.socket.write(
				`${JSON.stringify({ type: "response", requestId: afterSpawn.id, message: fauxAssistantMessage(fauxToolCall("restart_self", {}), { stopReason: "toolUse" }) })}\n`,
			);
			const restarted = await waitFor(
				() => readRecords<Startup>(startupsPath).filter((entry) => entry.sessionId === startup.sessionId)[1],
				"actual CLI process replacement",
				() => output,
			);
			expect(restarted.sessionFile).toBe(startup.sessionFile);
			expect(
				readRecords<{ pid: number }>(fixture.bootsPath).filter(
					(boot) => boot.pid === startup.pid || boot.pid === restarted.pid,
				).length,
			).toBeGreaterThanOrEqual(2);
			const resumedParent = await waitFor(
				() => requests.slice(requestCount).find((request) => request.sessionId === startup.sessionId),
				"post-restart parent request",
				() => output,
			);
			expect(resumedParent.messages).toContainEqual(
				expect.objectContaining({ role: "toolResult", toolName: "restart_self", isError: false }),
			);
			const resumedChild = await waitFor(
				() => requests.slice(requestCount).find((request) => request.sessionId === childRequest.sessionId),
				"recovered child C request",
				() => output,
			);
			expect(resumedChild).toMatchObject({ modelId: modelC, provider: "headless-faux" });
			expect(JSON.stringify(resumedChild.messages)).toContain(
				"CHILD_C_ASSIGNMENT: remain live across supervisor process restart",
			);
			expect(store.listAgents().find((agent) => agent.id === child.id)).toMatchObject({
				id: child.id,
				parentId: child.parentId,
				agentType: "explore",
				displayName: child.displayName,
				cwd: child.cwd,
				permission: child.permission,
				model: child.model,
				transcript: child.transcript,
			});
			console.log("interactive-process-restart", {
				changeSelection,
				before: expected,
				after: { modelId: resumedParent.modelId, reasoning: resumedParent.reasoning },
				sessionId: resumedParent.sessionId,
				childSessionId: resumedChild.sessionId,
			});
			expect(resumedParent).toMatchObject(expected);
			expect(readSessionMetadata(getControlDbPath(paths.agentDir), startup.sessionFile)).toMatchObject({
				modelProvider: expected.provider,
				modelId: expected.modelId,
				thinkingLevel: expected.reasoning,
			});
		} finally {
			if (bridge) await stopBridge(bridge);
			await probe?.close();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			rmSync(paths.tempDir, { recursive: true, force: true });
		}
	},
	120_000,
);
