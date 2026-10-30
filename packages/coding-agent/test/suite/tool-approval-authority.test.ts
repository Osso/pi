import { resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.ts";

const authorityPath = resolve("authority-test.ts");
const otherPath = resolve("other-test.ts");

describe("tool approval authority", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function run(policy: "never" | "auto-approve", factories: Array<{ path: string; factory: ExtensionFactory }>) {
		const executed: string[] = [];
		const tool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, input) => {
				const text = typeof input === "object" && input !== null && "text" in input ? String(input.text) : "";
				executed.push(text);
				return { content: [{ type: "text", text }], details: {} };
			},
		};
		const harness = await createHarness({
			settings: { approvalPolicy: policy, approvalPreset: policy === "never" ? "never-ask-deny" : "auto-approve" },
			tools: [tool],
			extensionFactories: factories,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "original" })], { stopReason: "toolUse" }),
			(context) =>
				fauxAssistantMessage(getMessageText(context.messages.find((message) => message.role === "toolResult"))),
		]);
		await harness.session.prompt("run");
		return { executed, texts: getAssistantTexts(harness) };
	}

	it("runs only the delegated handlers in order and preserves rewrites under never", async () => {
		const calls: string[] = [];
		const result = await run("never", [
			{
				path: otherPath,
				factory: (pi) => {
					pi.delegateToolApprovalsTo(authorityPath);
					pi.on("tool_call", () => {
						calls.push("other");
					});
				},
			},
			{
				path: authorityPath,
				factory: (pi) => {
					pi.on("tool_call", (event) => {
						calls.push("first");
						if (!("text" in event.input)) throw new Error("Expected echo input text");
						event.input.text = "rewritten";
					});
					pi.on("tool_call", () => {
						calls.push("second");
						return { block: false };
					});
				},
			},
		]);
		expect(calls).toEqual(["first", "second"]);
		expect(result.executed).toEqual(["rewritten"]);
	});

	it("denies under auto-approve and stops later handlers", async () => {
		const calls: string[] = [];
		const result = await run("auto-approve", [
			{ path: otherPath, factory: (pi) => pi.delegateToolApprovalsTo(authorityPath) },
			{
				path: authorityPath,
				factory: (pi) => {
					pi.on("tool_call", () => ({ block: true, reason: "authority denied" }));
					pi.on("tool_call", () => {
						calls.push("later");
					});
				},
			},
		]);
		expect(result.executed).toEqual([]);
		expect(result.texts).toContain("authority denied");
		expect(calls).toEqual([]);
	});

	it("applies unconditional gates before the delegated authority", async () => {
		let called = false;
		const result = await run("auto-approve", [
			{
				path: otherPath,
				factory: (pi) => {
					pi.delegateToolApprovalsTo(authorityPath);
					pi.registerToolGate(() => ({ block: true, reason: "gate denied" }));
				},
			},
			{
				path: authorityPath,
				factory: (pi) =>
					pi.on("tool_call", () => {
						called = true;
					}),
			},
		]);
		expect(result.executed).toEqual([]);
		expect(result.texts).toContain("gate denied");
		expect(called).toBe(false);
	});

	it("uses delegation registered after the factory returns", async () => {
		const result = await run("never", [
			{
				path: otherPath,
				factory: (pi) => pi.on("before_agent_start", () => pi.delegateToolApprovalsTo(authorityPath)),
			},
			{ path: authorityPath, factory: (pi) => pi.on("tool_call", () => undefined) },
		]);
		expect(result.executed).toEqual(["original"]);
	});

	it("preserves normal never and auto-approve without delegation", async () => {
		expect((await run("never", [])).executed).toEqual([]);
		expect((await run("auto-approve", [])).executed).toEqual(["original"]);
	});

	it("fails closed when one factory registers conflicting authorities", async () => {
		const result = await run("auto-approve", [
			{
				path: otherPath,
				factory: (pi) => {
					pi.delegateToolApprovalsTo(authorityPath);
					pi.delegateToolApprovalsTo(otherPath);
				},
			},
			{ path: authorityPath, factory: (pi) => pi.on("tool_call", () => ({ block: false })) },
		]);
		expect(result.executed).toEqual([]);
		expect(result.texts.join(" ")).toContain("Invalid or conflicting tool approval authority registrations");
	});

	it.each(["missing", "empty", "conflict", "throw"])("fails closed for %s authority", async (kind) => {
		const factories: Array<{ path: string; factory: ExtensionFactory }> = [
			{ path: otherPath, factory: (pi) => pi.delegateToolApprovalsTo(authorityPath) },
		];
		if (kind === "empty") factories.push({ path: authorityPath, factory: () => {} });
		if (kind === "throw")
			factories.push({
				path: authorityPath,
				factory: (pi) =>
					pi.on("tool_call", () => {
						throw new Error("authority failed");
					}),
			});
		if (kind === "conflict")
			factories.push({ path: authorityPath, factory: (pi) => pi.delegateToolApprovalsTo(authorityPath) });
		const result = await run("auto-approve", factories);
		expect(result.executed).toEqual([]);
		expect(result.texts.join(" ")).toMatch(/authority|conflicting/i);
	});
});
