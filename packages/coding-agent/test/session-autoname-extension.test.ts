import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import sessionAutonameExtension from "../extensions/session-autoname/src/index.ts";
import { getControlDbPath, readSessionMetadata } from "../src/core/session-control-db.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

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

	it("refuses to name a child agent session", async () => {
		const harness = await createSessionNameHarness({ multiAgentAgentId: "agent_1" });
		harness.setResponses([nameCall("Child Name"), endTurn()]);

		await harness.session.prompt("Rename the session");

		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		expect(toolResultErrors(harness, "set_session_name")).toEqual([true]);
		expect(toolResultTexts(harness, "set_session_name")[0]).toContain("Child agent sessions cannot be named");
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
