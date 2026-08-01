import { Container, type TUI } from "@earendil-works/pi-tui";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import {
	ResidentConsoleUi,
	parseResidentConsoleArgs,
} from "../src/cli/resident-console-command.ts";
import type { ResidentConsoleClient } from "../src/core/resident-console-transport.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
	},
};

type ResidentConsoleUiInternals = {
	chat: Container;
	handleEvent(this: ResidentConsoleUi, event: AgentSessionEvent): void;
};

const residentConsoleUi = ResidentConsoleUi.prototype as unknown as ResidentConsoleUiInternals;

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createResidentConsoleUi(): ResidentConsoleUi {
	const client = {
		snapshot: {
			service: "architect",
			sessionId: "session-1",
			cwd: process.cwd(),
			generation: 1,
			branch: [] as SessionEntry[],
		},
		onEvent: () => () => undefined,
		onDisconnect: () => () => undefined,
	} as unknown as ResidentConsoleClient<SessionEntry, AgentSessionEvent>;
	return new ResidentConsoleUi({ requestRender: vi.fn() } as unknown as TUI, client, "architect");
}

describe("resident console command", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("hides duplicate-turn output and the internal end_turn nudge from the resident console", () => {
		const ui = createResidentConsoleUi();
		const duplicateAssistant = createAssistantMessage("repeated response");

		residentConsoleUi.handleEvent.call(ui, { type: "message_start", message: duplicateAssistant });
		residentConsoleUi.handleEvent.call(ui, {
			type: "message_end",
			message: duplicateAssistant,
			runtimeMessageMarker: "duplicate_turn_assistant",
		});
		residentConsoleUi.handleEvent.call(ui, {
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "text", text: "internal nudge" }],
				timestamp: Date.now(),
			},
			runtimeMessageMarker: "duplicate_turn_guard",
		});

		expect((ui as unknown as ResidentConsoleUiInternals).chat.children).toHaveLength(0);
	});

	it("recognizes Supervisor and Architect console flags with optional initial prompts", () => {
		expect(parseResidentConsoleArgs(["--supervisor"])).toEqual({ service: "supervisor" });
		expect(parseResidentConsoleArgs(["--architect", "review", "this"])).toEqual({
			service: "architect",
			initialPrompt: "review this",
		});
	});

	it("leaves ordinary service and session commands unchanged", () => {
		expect(parseResidentConsoleArgs(["supervisor"])).toBeUndefined();
		expect(parseResidentConsoleArgs(["--model", "openai/gpt"])).toBeUndefined();
	});

	it("rejects resident console flags combined with normal CLI flags", () => {
		expect(() => parseResidentConsoleArgs(["--supervisor", "--model", "openai/gpt"])).toThrow("cannot be combined");
	});
});
