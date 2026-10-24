import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import sessionAutonameExtension from "../extensions/session-autoname/src/index.ts";
import { getControlDbPath, readSessionMetadata } from "../src/core/session-control-db.ts";
import { createHarness, getAssistantTexts, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0).reverse()) {
		harness.cleanup();
	}
});

interface SessionNameHarnessOptions {
	persistedSession?: boolean;
	multiAgentAgentId?: string;
}

async function createSessionNameHarness(options: SessionNameHarnessOptions = {}): Promise<Harness> {
	const harness = await createHarness({
		persistedSession: options.persistedSession ?? true,
		multiAgentAgentId: options.multiAgentAgentId,
		extensionFactories: [sessionAutonameExtension],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ mode: "tui" });
	return harness;
}

function nameCall(name: string) {
	return fauxAssistantMessage(fauxToolCall("set_session_name", { name }), { stopReason: "toolUse" });
}

function endTurn() {
	return fauxAssistantMessage(fauxToolCall("end_turn", { reason: "done" }), { stopReason: "toolUse" });
}

function toolResults(harness: Harness, toolName: string): ToolResultMessage[] {
	return harness.session.messages.filter(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName,
	);
}

function toolResultTexts(harness: Harness, toolName: string): string[] {
	return toolResults(harness, toolName).flatMap((message) =>
		message.content.map((part) => (part.type === "text" ? part.text : "")),
	);
}

function toolResultErrors(harness: Harness, toolName: string): boolean[] {
	return toolResults(harness, toolName).map((message) => message.isError);
}

describe("session naming tool extension", () => {
	it.each([
		{ session: "unnamed main", options: {} },
		{ session: "named main", options: {}, name: "Manual Name" },
		{ session: "explicitly cleared main", options: {}, name: undefined },
		{ session: "ephemeral", options: { persistedSession: false } },
		{ session: "child", options: { multiAgentAgentId: "agent_1" } },
	])("exposes scoped naming instructions to the model in a $session session", async (scenario) => {
		const harness = await createSessionNameHarness(scenario.options);
		if ("name" in scenario) harness.sessionManager.setSessionName(scenario.name);
		let description: string | undefined;
		let systemPrompt: string | undefined;
		harness.setResponses([
			(context) => {
				description = context.tools?.find((tool) => tool.name === "set_session_name")?.description;
				systemPrompt = context.systemPrompt;
				return endTurn();
			},
		]);

		await harness.session.prompt("Explain what 6 multiplied by 7 equals.");

		expect(description).toBe(
			"Set a short display name for an eligible persisted main session. Skip named, explicitly cleared, ephemeral, and child sessions. If naming is refused, continue the user's task; naming is not a prerequisite for task work.",
		);
		expect(systemPrompt).toContain(
			"Call set_session_name once, early, with a concise 2-4 word title describing the user's request only in an eligible persisted main session. Skip named, explicitly cleared, ephemeral, and child sessions.",
		);
		expect(systemPrompt).toContain(
			"If set_session_name refuses the request, continue the user's task. Do not stop or end the turn because naming failed; naming is not a prerequisite for task work.",
		);
		expect(harness.sessionManager.getSessionName()).toBe("name" in scenario ? scenario.name : undefined);
	});

	it("issues no provider request of its own when a user message starts", async () => {
		const harness = await createSessionNameHarness();
		harness.setResponses([endTurn()]);

		await harness.session.prompt("Rename the footer count logic");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
	});

	it("names the session when the model calls the tool and persists the name", async () => {
		const harness = await createSessionNameHarness();
		harness.setResponses([nameCall("Fix footer count"), endTurn()]);

		await harness.session.prompt("Rename the footer count logic");

		expect(harness.sessionManager.getSessionName()).toBe("Fix footer count");
		const sessionFile = harness.sessionManager.getSessionFile();
		expect(readSessionMetadata(getControlDbPath(harness.tempDir), sessionFile ?? "")?.name).toBe("Fix footer count");
		expect(toolResultTexts(harness, "set_session_name")).toEqual(['Session name set to "Fix footer count".']);
	});

	it("normalizes whitespace and bounds the stored name", async () => {
		const harness = await createSessionNameHarness();
		harness.setResponses([nameCall("  Fix   footer\n count  "), endTurn()]);

		await harness.session.prompt("Rename the footer count logic");

		expect(harness.sessionManager.getSessionName()).toBe("Fix footer count");
	});

	it("refuses to overwrite a name set outside the tool", async () => {
		const harness = await createSessionNameHarness();
		harness.sessionManager.setSessionName("Manual Name");
		harness.setResponses([nameCall("Model Name"), endTurn()]);

		await harness.session.prompt("Rename the session");

		expect(harness.sessionManager.getSessionName()).toBe("Manual Name");
		expect(toolResultErrors(harness, "set_session_name")).toEqual([true]);
		expect(toolResultTexts(harness, "set_session_name")[0]).toContain('already named "Manual Name"');
	});

	it("refuses to name a session whose name was explicitly cleared", async () => {
		const harness = await createSessionNameHarness();
		harness.sessionManager.setSessionName(undefined);
		harness.setResponses([nameCall("Model Name"), endTurn()]);

		await harness.session.prompt("Rename the session");

		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		expect(toolResultErrors(harness, "set_session_name")).toEqual([true]);
		expect(toolResultTexts(harness, "set_session_name")[0]).toContain("cleared explicitly");
	});

	it("keeps child naming refusal nonblocking for a useful task result", async () => {
		const harness = await createSessionNameHarness({ multiAgentAgentId: "agent_1" });
		let observedRefusal: ToolResultMessage | undefined;
		harness.setResponses([
			nameCall("Child Name"),
			(context) => {
				observedRefusal = context.messages.find(
					(message): message is ToolResultMessage =>
						message.role === "toolResult" && message.toolName === "set_session_name",
				);
				return fauxAssistantMessage("6 multiplied by 7 equals 42.");
			},
			endTurn(),
		]);

		await harness.session.prompt("Explain what 6 multiplied by 7 equals.");

		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		expect(toolResultErrors(harness, "set_session_name")).toEqual([true]);
		expect(toolResultTexts(harness, "set_session_name")[0]).toContain("Child agent sessions cannot be named");
		expect(observedRefusal?.isError).toBe(true);
		expect(getAssistantTexts(harness)).toContain("6 multiplied by 7 equals 42.");
	});

	it("refuses to name an ephemeral session", async () => {
		const harness = await createSessionNameHarness({ persistedSession: false });
		harness.setResponses([nameCall("Ephemeral Name"), endTurn()]);

		await harness.session.prompt("Rename the session");

		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		expect(toolResultErrors(harness, "set_session_name")).toEqual([true]);
		expect(toolResultTexts(harness, "set_session_name")[0]).toContain("Only persisted sessions can be named");
	});

	it("rejects an empty name", async () => {
		const harness = await createSessionNameHarness();
		harness.setResponses([nameCall("   "), endTurn()]);

		await harness.session.prompt("Rename the session");

		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		expect(toolResultErrors(harness, "set_session_name")).toEqual([true]);
	});

	it("allows the model to correct a name it set earlier", async () => {
		const harness = await createSessionNameHarness();
		harness.setResponses([nameCall("First Title"), nameCall("Second Title"), endTurn()]);

		await harness.session.prompt("Rename the session");

		expect(harness.sessionManager.getSessionName()).toBe("Second Title");
		expect(toolResultErrors(harness, "set_session_name")).toEqual([false, false]);
	});
});
