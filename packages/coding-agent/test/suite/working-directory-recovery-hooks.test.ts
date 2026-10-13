import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.ts";

function completedResponse(text: string) {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })]);
}

describe("working-directory recovery hooks", () => {
	const harnesses: Harness[] = [];
	async function harness(): Promise<Harness> {
		const result = await createHarness({ tools: [] });
		harnesses.push(result);
		return result;
	}
	afterEach(() => {
		for (const result of harnesses.splice(0)) result.cleanup();
	});

	it("delegates the original prompt and attachments to the replacement before preflight", async () => {
		const original = await harness();
		const replacement = await harness();
		replacement.setResponses([completedResponse("recovered")]);
		original.session.setWorkingDirectoryRecoveryHandlers({
			beforeRun: async () => replacement.session,
			afterTurn: async () => {},
		});
		const accepted: boolean[] = [];
		const prepared: string[] = [];
		await original.session.prompt("/literal", {
			expandPromptTemplates: false,
			images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
			source: "rpc",
			preflightResult: (success) => accepted.push(success),
			onUserMessagePrepared: (message) => prepared.push(message.role),
		});
		expect(original.session.messages).toEqual([]);
		expect(getUserTexts(replacement)).toEqual(["/literal"]);
		expect(replacement.session.messages[0]).toMatchObject({
			inputSource: "rpc",
			content: [
				{ type: "text", text: "/literal" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
		});
		expect(accepted).toEqual([true]);
		expect(prepared).toEqual(["user"]);
		expect(getAssistantTexts(replacement)).toEqual(["recovered"]);
	});

	it("delegates continuation even when the replaced session has no transcript", async () => {
		const original = await harness();
		const replacement = await harness();
		replacement.session.agent.state.messages.push({
			role: "user",
			content: [{ type: "text", text: "unfinished" }],
			timestamp: 1,
		});
		replacement.setResponses([completedResponse("continued")]);
		original.session.setWorkingDirectoryRecoveryHandlers({
			beforeRun: async () => replacement.session,
			afterTurn: async () => {},
		});
		await original.session.continue();
		expect(original.session.messages).toEqual([]);
		expect(getUserTexts(replacement)).toEqual(["unfinished"]);
		expect(getAssistantTexts(replacement)).toEqual(["continued"]);
	});

	it("runs in the original session when recovery returns undefined or that same session", async () => {
		const current = await harness();
		let checks = 0;
		let turns = 0;
		current.session.setWorkingDirectoryRecoveryHandlers({
			beforeRun: async () => (++checks === 1 ? undefined : current.session),
			afterTurn: async () => {
				turns++;
			},
		});
		current.setResponses([completedResponse("first"), completedResponse("second")]);
		await current.session.prompt("one");
		await current.session.prompt("two");
		expect(getUserTexts(current)).toEqual(["one", "two"]);
		expect(checks).toBe(2);
		expect(turns).toBe(2);
	});

	it("does not recover or redirect prompts queued while streaming", async () => {
		const current = await harness();
		let signalRequest!: () => void;
		const requested = new Promise<void>((resolve) => {
			signalRequest = resolve;
		});
		let releaseResponse!: () => void;
		const responseReady = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		let checks = 0;
		current.session.setWorkingDirectoryRecoveryHandlers({
			beforeRun: async () => {
				checks++;
				return undefined;
			},
			afterTurn: async () => {},
		});
		current.setResponses([
			async () => {
				signalRequest();
				await responseReady;
				return completedResponse("first");
			},
			completedResponse("followed up"),
		]);
		const running = current.session.prompt("one");
		await requested;
		try {
			await current.session.prompt("two", { streamingBehavior: "followUp" });
			expect(current.session.getFollowUpMessages()).toEqual(["two"]);
			expect(checks).toBe(1);
			await expect(current.session.continue()).rejects.toThrow("Agent is already processing");
			expect(checks).toBe(1);
		} finally {
			releaseResponse();
			await running;
		}
		expect(getUserTexts(current)).toEqual(["one", "two"]);
		expect(getAssistantTexts(current)).toEqual(["first", "followed up"]);
	});

	it("prepares after-turn recovery before stop predicates and activates at the normal agent-end boundary", async () => {
		const current = await harness();
		const order: string[] = [];
		const runner = current.session.extensionRunner;
		runner.setToolResultRelocationHandlers({
			prepare: async (cwd) => {
				await Promise.resolve();
				order.push(`prepare:${cwd}`);
			},
			activate: async () => {
				order.push("activate");
			},
		});
		current.session.subscribe((event) => {
			if (event.type === "agent_end") order.push(`end:${event.sessionContinuation}`);
		});
		current.session.setWorkingDirectoryRecoveryHandlers({
			beforeRun: async () => undefined,
			afterTurn: async () => {
				order.push("afterTurn");
				await runner.prepareWorkingDirectoryRelocation("/recovered");
			},
		});
		current.setResponses([
			fauxAssistantMessage("recover before the next model request"),
			fauxAssistantMessage("must not request again"),
		]);
		await current.session.prompt("recover after the turn");
		expect(order).toEqual(["afterTurn", "prepare:/recovered", "end:cwd_relocation", "activate"]);
		expect(current.getPendingResponseCount()).toBe(1);
		expect(runner.hasPreparedToolResultRelocation()).toBe(false);
	});

	it("does not mark a failed preparation ready for activation", async () => {
		const current = await harness();
		const activated: string[] = [];
		const runner = current.session.extensionRunner;
		runner.setToolResultRelocationHandlers({
			prepare: async () => {
				throw new Error("cannot prepare relocation");
			},
			activate: async () => {
				activated.push("activated");
			},
		});
		await expect(runner.prepareWorkingDirectoryRelocation("/unavailable")).rejects.toThrow(
			"cannot prepare relocation",
		);
		await runner.activateToolResultRelocation();
		expect(runner.hasPreparedToolResultRelocation()).toBe(false);
		expect(activated).toEqual([]);
	});
});
