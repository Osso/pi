import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../../../ai/src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../../../ai/src/types.ts";
import { AssistantMessageEventStream } from "../../../ai/src/utils/event-stream.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const RAW_CITATION_MARKER = "citeturn2search1";
const NORMALIZED_TEXT =
	"Niri’s cursor setting also establishes XCURSOR_THEME and XCURSOR_SIZE for launched applications.";

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

async function* createCitationEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		sequence_number: 0,
		output_index: 0,
		item: {
			type: "web_search_call",
			id: "ws_citation",
			status: "completed",
			action: { type: "search", query: "citation persistence test" },
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.added",
		sequence_number: 1,
		output_index: 1,
		item: { type: "message", id: "msg_citation", role: "assistant", status: "in_progress", content: [] },
	} as ResponseStreamEvent;
	yield {
		type: "response.output_text.delta",
		sequence_number: 2,
		output_index: 1,
		content_index: 0,
		item_id: "msg_citation",
		delta: `${NORMALIZED_TEXT} `,
	} as ResponseStreamEvent;
	yield {
		type: "response.output_text.delta",
		sequence_number: 3,
		output_index: 1,
		content_index: 0,
		item_id: "msg_citation",
		delta: "citeturn2search1",
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		sequence_number: 4,
		output_index: 1,
		item: {
			type: "message",
			id: "msg_citation",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: `${NORMALIZED_TEXT} ${RAW_CITATION_MARKER}`, annotations: [] }],
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: 5,
		response: { id: "resp_citation", status: "completed" },
	} as ResponseStreamEvent;
}

describe("SessionManager OpenAI Responses citation persistence", () => {
	it("persists and reloads finalized normalized assistant text without raw citation markers", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		await processResponsesStream(createCitationEvents(), output, stream, model);

		const tempDir = mkdtempSync(join(tmpdir(), "pi-citation-persistence-"));
		try {
			const cwd = join(tempDir, "project");
			mkdirSync(cwd);
			const session = SessionManager.create(cwd, tempDir);
			session.appendMessage({ role: "user", content: "Explain the cursor setting.", timestamp: 1 });
			session.appendMessage(output);

			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session file");

			const reloaded = SessionManager.open(sessionFile, tempDir);
			const assistant = reloaded.buildSessionContext().messages.find((message) => message.role === "assistant");
			if (!assistant || assistant.role !== "assistant") throw new Error("Expected reloaded assistant message");

			const textBlock = assistant.content.find((content) => content.type === "text");
			expect(textBlock).toMatchObject({ type: "text", text: NORMALIZED_TEXT });
			expect(JSON.stringify(reloaded.getEntries())).not.toContain(RAW_CITATION_MARKER);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
