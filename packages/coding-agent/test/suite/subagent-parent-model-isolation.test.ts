import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type Message, type Tool } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { type HeadlessLlmRequest, type HeadlessPi, withHeadlessPi } from "./headless-pi.ts";

interface ObservedRequest {
	sessionId: string;
	provider: string;
	modelId: string;
	api: string;
	systemPrompt: string;
	messages: Message[];
	tools: Tool[];
}

function complete(text: string) {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

function assertProviderRequest(logPath: string, request: HeadlessLlmRequest, modelId: string): ObservedRequest {
	const observations = readFileSync(logPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as ObservedRequest);
	const observed = observations.findLast((candidate) => candidate.sessionId === request.sessionId);
	expect(observed, `Actual provider invocation for ${request.sessionId}`).toBeDefined();
	expect(observed).toMatchObject({
		provider: "headless-faux",
		modelId,
		api: "headless-faux",
	});
	expect(observed?.messages).toEqual(request.messages);
	expect(observed?.systemPrompt).toEqual(request.systemPrompt);
	expect(observed?.tools).toEqual(request.tools);
	if (!observed) throw new Error("Missing provider invocation");
	console.log(
		"parent-model-isolation",
		JSON.stringify({
			sessionId: observed.sessionId,
			provider: observed.provider,
			modelId: observed.modelId,
			api: observed.api,
		}),
	);
	return observed;
}

function assertParentContext(
	agent: HeadlessPi,
	request: HeadlessLlmRequest,
	source: ObservedRequest,
	metadata: ReturnType<HeadlessPi["readSessionMetadata"]>,
): void {
	expect(request.sessionId).toBe(source.sessionId);
	expect(request.agentId).toBeNull();
	expect(request.systemPrompt).toBe(source.systemPrompt);
	expect(request.tools).toEqual(source.tools);
	expect(request.messages.slice(0, source.messages.length)).toEqual(source.messages);
	expect(request.userMessages).not.toContain("CHILD_ONLY_CONTEXT: remain live for the parent restart");
	expect(agent.readSessionMetadata(null)).toEqual(metadata);
}

describe("subagent parent model isolation", () => {
	it("keeps actual parent requests on reasoning A through explore B spawn and restart with a live child", async () => {
		const probeDir = mkdtempSync(join(tmpdir(), "pi-parent-model-isolation-"));
		const logPath = join(probeDir, "provider-requests.jsonl");
		const preloadPath = join(probeDir, "observe-provider.mjs");
		const fixturePreload = pathToFileURL(
			join(import.meta.dirname, "fixtures", "headless-pi-provider-preload.ts"),
		).href;
		// The fixture transport omits model identity. Observe the real dispatch arguments without changing them.
		writeFileSync(
			preloadPath,
			`
import ${JSON.stringify(fixturePreload)};
import { appendFileSync } from "node:fs";
import { getApiProvider, registerApiProvider } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/compat"))};
const provider = getApiProvider("headless-faux");
if (!provider) throw new Error("Missing headless faux provider");
function observe(stream) {
	return (model, context, options) => {
		appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
			sessionId: options?.sessionId, provider: model.provider, modelId: model.id, api: model.api,
			systemPrompt: context.systemPrompt, messages: context.messages, tools: context.tools,
		}) + "\\n");
		return stream(model, context, options);
	};
}
registerApiProvider({ api: provider.api, stream: observe(provider.stream), streamSimple: observe(provider.streamSimple) });
`,
		);
		try {
			await withHeadlessPi(
				async (agent) => {
					const settingsPath = join(agent.paths.agentDir, "settings.json");
					const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
					writeFileSync(
						settingsPath,
						JSON.stringify({
							...settings,
							// Delegation policy injection is independent of model/context isolation.
							disabledExtensions: [...(settings.disabledExtensions as string[]), "effort"],
							agents: {
								explore: {
									model: "headless-faux/headless-faux-1",
									thinkingLevel: "off",
								},
							},
						}),
					);
					await agent.restart();
					expect(
						await agent.send({
							type: "set_model",
							provider: "headless-faux",
							modelId: "headless-faux-reasoning",
						}),
					).toMatchObject({ success: true });
					await agent.send({
						type: "prompt",
						message: "PARENT_SOURCE_CONTEXT: spawn explore B while continuing reasoning A",
					});
					const initial = await agent.waitForLlmRequest((request) => request.agentId === null);
					const source = assertProviderRequest(logPath, initial, "headless-faux-reasoning");
					const metadata = agent.readSessionMetadata(null);
					expect(metadata).toMatchObject({
						modelProvider: "headless-faux",
						modelId: "headless-faux-reasoning",
					});
					agent.respondToLlmRequest(
						initial.id,
						fauxAssistantMessage(
							fauxToolCall("spawn_agent", {
								agentType: "explore",
								context: "fresh",
								displayName: "Isolated explore B",
								prompt: "CHILD_ONLY_CONTEXT: remain live for the parent restart",
							}),
							{ stopReason: "toolUse" },
						),
					);
					const child = await agent.waitForAgent((candidate) => candidate.displayName === "Isolated explore B");
					const childRequest = await agent.waitForLlmRequest((request) => request.agentId === child.id);
					assertProviderRequest(logPath, childRequest, "headless-faux-1");
					expect(childRequest.systemPrompt).not.toEqual(source.systemPrompt);
					expect(childRequest.userMessages).not.toContain(initial.userMessages[0]);
					const afterSpawn = await agent.waitForLlmRequest(
						(request) => request.agentId === null && request.id !== initial.id,
					);
					assertProviderRequest(logPath, afterSpawn, "headless-faux-reasoning");
					assertParentContext(agent, afterSpawn, source, metadata);
					expect(agent.listAgents().find((candidate) => candidate.id === child.id)?.lifecycle).toBe("running");
					await agent.crash();
					await agent.restart();
					const resumedChild = await agent.waitForLlmRequest((request) => request.agentId === child.id);
					assertProviderRequest(logPath, resumedChild, "headless-faux-1");
					expect(resumedChild.userMessages).toContain("CHILD_ONLY_CONTEXT: remain live for the parent restart");
					expect(agent.listAgents().find((candidate) => candidate.id === child.id)?.transcript).toEqual(
						child.transcript,
					);
					const resumedParent = await agent.waitForLlmRequest((request) => request.agentId === null);
					assertProviderRequest(logPath, resumedParent, "headless-faux-reasoning");
					assertParentContext(agent, resumedParent, source, metadata);
					// Prove another actual parent tool-loop request, not only the replayed interrupted request.
					agent.respondToLlmRequest(
						resumedParent.id,
						fauxAssistantMessage(fauxToolCall("list_agents", {}), {
							stopReason: "toolUse",
						}),
					);
					const continued = await agent.waitForLlmRequest(
						(request) => request.agentId === null && request.id !== resumedParent.id,
					);
					assertProviderRequest(logPath, continued, "headless-faux-reasoning");
					assertParentContext(agent, continued, source, metadata);
					agent.respondToLlmRequest(continued.id, complete("Parent remained reasoning A"));
					await agent.waitForEvent((event) => event.type === "agent_end");
					agent.respondToLlmRequest(resumedChild.id, complete("Explore B completed"));
					await agent.waitForAgent(
						(candidate) => candidate.id === child.id && candidate.lifecycle === "completed",
					);
				},
				{
					model: "headless-faux-reasoning",
					env: { NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}` },
				},
			);
		} finally {
			rmSync(probeDir, { recursive: true, force: true });
		}
	}, 90_000);
});
