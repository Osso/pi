import { describe, expect, it, vi } from "vitest";
import codexFastExtension from "../extensions/codex-fast/src/index.ts";
import type {
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
} from "../src/core/extensions/types.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

type BeforeProviderRequestHandler = (
	event: BeforeProviderRequestEvent,
	ctx: ExtensionContext,
) => Record<string, unknown> | undefined;

function createHarness(provider = "openai-codex") {
	let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
	let beforeProviderRequest: BeforeProviderRequestHandler | undefined;
	const pi = {
		on: (event: string, handler: BeforeProviderRequestHandler) => {
			if (event === "before_provider_request") beforeProviderRequest = handler;
		},
		registerCommand: (_name: string, value: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			command = value;
		},
	} as unknown as ExtensionAPI;
	codexFastExtension(pi);

	const notify = vi.fn();
	const setEditorText = vi.fn();
	const setStatus = vi.fn();
	const ctx = {
		model: {
			api: provider.startsWith("openai-codex") ? "openai-codex-responses" : "anthropic-messages",
			id: "test-model",
			provider,
		},
		ui: { notify, setEditorText, setStatus },
	} as unknown as ExtensionCommandContext;
	if (!command) throw new Error("/fast command was not registered");
	if (!beforeProviderRequest) throw new Error("before_provider_request handler was not registered");
	return { beforeProviderRequest, command, ctx, notify, setEditorText, setStatus };
}

describe("Codex fast mode extension", () => {
	it("keeps /fast out of built-in slash commands", () => {
		expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).not.toContain("fast");
	});

	it("toggles priority mode and footer status for the current runtime", async () => {
		const { command, ctx, notify, setEditorText, setStatus } = createHarness();

		await command.handler("", ctx);
		expect(notify).toHaveBeenLastCalledWith("Fast mode: on", "info");
		expect(setStatus).toHaveBeenLastCalledWith("codex-fast", "fast");

		await command.handler("", ctx);
		expect(notify).toHaveBeenLastCalledWith("Fast mode: off", "info");
		expect(setStatus).toHaveBeenLastCalledWith("codex-fast", undefined);
		expect(setEditorText).toHaveBeenCalledTimes(2);
	});

	it("supports explicit on and off arguments", async () => {
		const { command, ctx, notify } = createHarness("openai-codex-gc");

		await command.handler("on", ctx);
		await command.handler("off", ctx);

		expect(notify).toHaveBeenNthCalledWith(1, "Fast mode: on", "info");
		expect(notify).toHaveBeenNthCalledWith(2, "Fast mode: off", "info");
	});

	it("rejects enabling fast mode for unsupported providers", async () => {
		const { command, ctx, notify, setStatus } = createHarness("anthropic");

		await command.handler("on", ctx);

		expect(notify).toHaveBeenCalledWith("Fast mode requires openai-codex or openai-codex-gc", "warning");
		expect(setStatus).not.toHaveBeenCalledWith("codex-fast", "fast");
	});

	it("adds priority service tier only while enabled on Codex requests", async () => {
		const { beforeProviderRequest, command, ctx } = createHarness();
		const event = { payload: { model: "test-model" }, type: "before_provider_request" } as BeforeProviderRequestEvent;

		expect(beforeProviderRequest(event, ctx)).toBeUndefined();
		await command.handler("on", ctx);
		expect(beforeProviderRequest(event, ctx)).toEqual({ model: "test-model", service_tier: "priority" });
		await command.handler("off", ctx);
		expect(beforeProviderRequest(event, ctx)).toBeUndefined();
	});

	it("starts disabled when the runtime extension is recreated", async () => {
		const first = createHarness();
		await first.command.handler("on", first.ctx);
		const second = createHarness();
		const event = { payload: { model: "test-model" }, type: "before_provider_request" } as BeforeProviderRequestEvent;

		expect(second.beforeProviderRequest(event, second.ctx)).toBeUndefined();
	});
});
