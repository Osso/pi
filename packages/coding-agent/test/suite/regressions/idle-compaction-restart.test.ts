import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { type HeadlessPi, withHeadlessPi } from "../headless-pi.ts";

const API = "openai-codex-responses";
const MODEL_ID = "idle-cache-model";
const SOURCE_TEXT = "IDLE_SOURCE: completed investigation; preserve the findings in a checkpoint.";
const SUMMARY_TEXT = "Idle restart checkpoint: investigation completed, findings preserved.";
const CACHE_DUE_OFFSET_MS = 27 * 60_000;
const DUE_AFTER_RESPONSE_MS = 10_000;
const OBSERVATION_WINDOW_MS = 3000;

interface ProviderObservation {
	type: "boot" | "request";
	pid: number;
	at: number;
	api?: string;
	provider?: string;
	modelId?: string;
	prompt?: string;
}

function readProviderObservations(path: string): ProviderObservation[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ProviderObservation);
}

function writeProviderPreload(directory: string, contextTokens: number) {
	const preloadPath = join(directory, "idle-provider.mjs");
	const observationsPath = join(directory, "provider-observations.jsonl");
	writeFileSync(observationsPath, "");
	const fixturePreload = pathToFileURL(
		join(import.meta.dirname, "..", "fixtures", "headless-pi-provider-preload.ts"),
	).href;
	writeFileSync(
		preloadPath,
		`
import ${JSON.stringify(fixturePreload)};
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, getApiProvider, registerApiProvider } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/compat"))};
const observationsPath = ${JSON.stringify(observationsPath)};
const agentDir = process.env.PI_CODING_AGENT_DIR;
const modelsPath = join(agentDir, "models.json");
const models = JSON.parse(readFileSync(modelsPath, "utf8"));
models.providers["openai-codex"] = {
 api: ${JSON.stringify(API)}, apiKey: "test-key", baseUrl: "http://localhost:0",
 models: [{ id: ${JSON.stringify(MODEL_ID)}, name: "Idle cache test", reasoning: false,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000000, maxTokens: 16384 }],
};
writeFileSync(modelsPath, JSON.stringify(models));
const settingsPath = join(agentDir, "settings.json");
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
settings.compaction = { ...settings.compaction, keepRecentTokens: 1, reserveTokens: 1000 };
// Exercise built-in summarization through faux transport, never the remote Codex compact endpoint.
settings.disabledExtensions = [...new Set([...settings.disabledExtensions, "openai-remote-compact"])];
// Temporary RED runs disable only idle compaction, not threshold or built-in summarization.
if (process.env.PI_IDLE_COMPACTION_RED === "1") settings.compaction.idle = false;
writeFileSync(settingsPath, JSON.stringify(settings));
appendFileSync(observationsPath, JSON.stringify({ type: "boot", pid: process.pid, at: Date.now() }) + "\\n");
const faux = getApiProvider("headless-faux");
if (!faux) throw new Error("Missing headless faux provider");
function rewriteMessage(message, model) {
 const isSource = message.content.some((part) => part.type === "text" && part.text.includes("IDLE_SOURCE:"));
 return { ...message, api: model.api, provider: model.provider, model: model.id,
  ...(isSource ? { usage: { input: 100000, output: 0, cacheRead: ${contextTokens - 100_000}, cacheWrite: 0,
   totalTokens: ${contextTokens}, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } : {}) };
}
function wrap(stream) {
 return (model, context, options) => {
  appendFileSync(observationsPath, JSON.stringify({ type: "request", pid: process.pid, at: Date.now(),
   api: model.api, provider: model.provider, modelId: model.id, prompt: JSON.stringify(context) }) + "\\n");
  const output = createAssistantMessageEventStream();
  const input = stream({ ...model, api: faux.api }, context, options);
  (async () => {
   try {
    for await (const event of input) {
     if ("partial" in event) event.partial = rewriteMessage(event.partial, model);
     if (event.type === "done") event.message = rewriteMessage(event.message, model);
     if (event.type === "error") event.error = rewriteMessage(event.error, model);
     output.push(event);
    }
    output.end(rewriteMessage(await input.result(), model));
   } catch (error) { output.fail(error); }
  })();
  return output;
 };
}
const provider = { api: ${JSON.stringify(API)}, stream: wrap(faux.stream), streamSimple: wrap(faux.streamSimple) };
registerApiProvider(provider);
globalThis.idleCompactionTestProvider = provider;
// ModelRegistry.refresh resets built-in API overrides. Re-register through the extension boundary.
writeFileSync(join(agentDir, "extensions", "idle-provider.mjs"),
 'import { readFileSync } from "node:fs";\\n' +
 'export default function(pi) {\\n' +
 ' const config = JSON.parse(readFileSync(' + JSON.stringify(modelsPath) + ', "utf8")).providers["openai-codex"];\\n' +
 ' pi.registerProvider("openai-codex", { ...config, streamSimple: globalThis.idleCompactionTestProvider.streamSimple });\\n' +
 '}\\n');
`,
	);
	return { preloadPath, observationsPath };
}

async function persistResponseThenCrash(runtime: HeadlessPi, observationsPath: string, contextTokens: number) {
	// Keep one completed turn outside the protected recent suffix so summarization has real history.
	expect(
		await runtime.send({
			type: "prompt",
			message: "Investigate the idle cache regression: prior completed findings.",
		}),
	).toMatchObject({ success: true });
	const history = await runtime.waitForLlmRequest((request) => request.agentId === null);
	runtime.respondToLlmRequest(
		history.id,
		fauxAssistantMessage(
			[
				{ type: "text", text: "Prior finding: the completed investigation needs a durable context checkpoint." },
				fauxToolCall("end_turn", { reason: "history complete" }),
			],
			{ stopReason: "toolUse" },
		),
	);
	await runtime.waitForEvent((event) => event.type === "agent_end");
	const prompted = await runtime.send({
		type: "prompt",
		message: "Investigate the idle cache regression and record completed findings.",
	});
	expect(prompted).toMatchObject({ success: true });
	const request = await runtime.waitForLlmRequest((candidate) => candidate.agentId === null);
	const dueAt = Date.now() + DUE_AFTER_RESPONSE_MS;
	const timestamp = dueAt - CACHE_DUE_OFFSET_MS;
	runtime.respondToLlmRequest(
		request.id,
		fauxAssistantMessage(
			[{ type: "text", text: SOURCE_TEXT }, fauxToolCall("end_turn", { reason: "investigation complete" })],
			{ timestamp, stopReason: "toolUse" },
		),
	);
	const persisted = await runtime.waitForSessionEntry(
		null,
		(entry) =>
			entry.type === "message" && entry.message.role === "assistant" && entry.message.timestamp === timestamp,
	);
	expect(persisted).toMatchObject({
		type: "message",
		message: {
			api: API,
			provider: "openai-codex",
			model: MODEL_ID,
			timestamp,
			usage: { input: 100_000, cacheRead: contextTokens - 100_000, output: 0, cacheWrite: 0 },
		},
	});
	await runtime.waitForEvent((event) => event.type === "agent_end");
	expect(readProviderObservations(observationsPath).filter((entry) => entry.type === "request")).toHaveLength(2);
	expect(runtime.readSessionEntries(null).filter((entry) => entry.type === "compaction")).toHaveLength(0);
	await runtime.crash();
	expect(Date.now(), "Process must crash before the cache deadline").toBeLessThan(dueAt);
	expect(readProviderObservations(observationsPath).filter((entry) => entry.type === "request")).toHaveLength(2);
	return { dueAt, timestamp };
}

async function restartSameSession(runtime: HeadlessPi, observationsPath: string) {
	const sessionId = runtime.sessionId;
	const sessionFile = runtime.sessionFile;
	const before = readProviderObservations(observationsPath).filter((entry) => entry.type === "boot");
	await runtime.restart();
	// HeadlessPi's sessionId/sessionFile properties are startup snapshots; query the actual restarted process.
	const state = await runtime.send({ type: "get_state" });
	expect(state).toMatchObject({ success: true, data: { sessionId, sessionFile } });
	const after = readProviderObservations(observationsPath).filter((entry) => entry.type === "boot");
	expect(after).toHaveLength(before.length + 1);
	expect(after.at(-1)?.pid).not.toBe(before.at(-1)?.pid);
	return after.at(-1)?.pid;
}

async function withIdleProvider(
	contextTokens: number,
	scenario: (runtime: HeadlessPi, logPath: string) => Promise<void>,
) {
	const directory = mkdtempSync(join(tmpdir(), "pi-idle-compaction-restart-"));
	const { preloadPath, observationsPath } = writeProviderPreload(directory, contextTokens);
	try {
		await withHeadlessPi((runtime) => scenario(runtime, observationsPath), {
			provider: "openai-codex",
			model: MODEL_ID,
			env: { NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}` },
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function isSummarizationPrompt(prompt: string): boolean {
	return prompt.includes("structured context checkpoint summary") || prompt.includes("Summarize the prefix");
}

describe("idle compaction across real-process restart", () => {
	it("re-arms the persisted cache deadline and compacts exactly once while idle", async () => {
		await withIdleProvider(200_000, async (runtime, logPath) => {
			const { dueAt } = await persistResponseThenCrash(runtime, logPath, 200_000);
			const restartedPid = await restartSameSession(runtime, logPath);
			const summaryRequest = await runtime.waitForLlmRequest(
				(request) => request.userMessages.some(isSummarizationPrompt),
				Math.max(1, dueAt - Date.now()) + 5000,
			);
			expect(summaryRequest.userMessages.join("\n")).toContain("<conversation>");
			expect(summaryRequest.userMessages.join("\n")).toContain("Investigate the idle cache regression");
			const observation = readProviderObservations(logPath).find(
				(entry) => entry.type === "request" && isSummarizationPrompt(entry.prompt ?? ""),
			);
			expect(observation).toMatchObject({
				pid: restartedPid,
				api: API,
				provider: "openai-codex",
				modelId: MODEL_ID,
			});
			expect(observation?.at).toBeGreaterThanOrEqual(dueAt - 100);
			expect(observation?.at).toBeLessThan(dueAt + 5000);
			runtime.respondToLlmRequest(summaryRequest.id, fauxAssistantMessage(SUMMARY_TEXT));
			const compaction = await runtime.waitForSessionEntry(null, (entry) => entry.type === "compaction");
			expect(compaction).toMatchObject({ type: "compaction", summary: expect.stringContaining(SUMMARY_TEXT) });
			const ended = await runtime.waitForEvent((event) => event.type === "compaction_end");
			expect(ended).toMatchObject({ reason: "idle", aborted: false, willRetry: false });
			await delay(OBSERVATION_WINDOW_MS);
			expect(runtime.readSessionEntries(null).filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expect(readProviderObservations(logPath).filter((entry) => entry.type === "request")).toHaveLength(3);
			expect(await runtime.send({ type: "get_state" })).toMatchObject({
				success: true,
				data: { isStreaming: false },
			});
		});
	}, 60_000);

	it("does not compact a persisted context below 200,000 tokens after its cache deadline", async () => {
		await withIdleProvider(199_999, async (runtime, logPath) => {
			const { dueAt } = await persistResponseThenCrash(runtime, logPath, 199_999);
			await restartSameSession(runtime, logPath);
			await delay(Math.max(0, dueAt - Date.now()) + OBSERVATION_WINDOW_MS);
			expect(readProviderObservations(logPath).filter((entry) => entry.type === "request")).toHaveLength(2);
			expect(runtime.readSessionEntries(null).filter((entry) => entry.type === "compaction")).toHaveLength(0);
			expect(await runtime.send({ type: "get_state" })).toMatchObject({
				success: true,
				data: { isStreaming: false },
			});
		});
	}, 60_000);
});
