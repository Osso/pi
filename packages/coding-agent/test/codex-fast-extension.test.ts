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

type BeforeProviderRequestHandler = (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => unknown;
type ModelSelectHandler = (event: { model: ExtensionContext["model"] }, ctx: ExtensionContext) => void;
type SessionStartHandler = (event: { type: "session_start" }, ctx: ExtensionContext) => void;

interface FastModeAuthority {
	enabled: boolean;
}

function createHarness(provider = "openai-codex", authority?: FastModeAuthority, child = false) {
	let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
	let commandName: string | undefined;
	let beforeProviderRequest: BeforeProviderRequestHandler | undefined;
	let modelSelect: ModelSelectHandler | undefined;
	let sessionStart: SessionStartHandler | undefined;
	const pi = {
		on: (event: string, handler: BeforeProviderRequestHandler | ModelSelectHandler | SessionStartHandler) => {
			if (event === "before_provider_request") beforeProviderRequest = handler as BeforeProviderRequestHandler;
			if (event === "model_select") modelSelect = handler as ModelSelectHandler;
			if (event === "session_start") sessionStart = handler as SessionStartHandler;
		},
		registerCommand: (name: string, value: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commandName = name;
			command = value;
		},
	} as unknown as ExtensionAPI;
	codexFastExtension(pi, authority ? { authority } : undefined);

	const notify = vi.fn();
	const setEditorText = vi.fn();
	const setStatus = vi.fn();
	const ctx = {
		model: {
			api: provider.startsWith("openai-codex") ? "openai-codex-responses" : "anthropic-messages",
			id: "test-model",
			provider,
		},
		multiAgentAgentId: child ? "child-agent" : undefined,
		ui: { notify, setEditorText, setStatus },
	} as unknown as ExtensionCommandContext;
	if (!command) throw new Error("/fast command was not registered");
	if (!beforeProviderRequest) throw new Error("before_provider_request handler was not registered");
	if (!modelSelect) throw new Error("model_select handler was not registered");
	return { beforeProviderRequest, command, commandName, ctx, modelSelect, notify, sessionStart, setEditorText, setStatus };
}

describe("Codex fast mode extension", () => {
	it("keeps /fast out of built-in slash commands", () => {
		expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).not.toContain("fast");
	});

	it("toggles priority mode and footer status for the current runtime", async () => {
		const { command, commandName, ctx, notify, setEditorText, setStatus } = createHarness();

		expect(commandName).toBe("fast");

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

	it("rejects ordinary OpenAI providers", async () => {
		const { command, ctx, notify } = createHarness("openai");

		await command.handler("on", ctx);

		expect(notify).toHaveBeenCalledWith("Fast mode requires openai-codex or openai-codex-gc", "warning");
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

	it("updates footer activity across provider switches without losing the runtime toggle", async () => {
		const { beforeProviderRequest, command, ctx, modelSelect, setStatus } = createHarness();
		const event = { payload: { model: "test-model" }, type: "before_provider_request" } as BeforeProviderRequestEvent;
		await command.handler("on", ctx);
		const mutableContext = ctx as unknown as { model: ExtensionContext["model"] };
		mutableContext.model = { ...ctx.model!, api: "anthropic-messages", provider: "anthropic" };
		modelSelect({ model: mutableContext.model }, ctx);

		expect(setStatus).toHaveBeenLastCalledWith("codex-fast", undefined);
		expect(beforeProviderRequest(event, ctx)).toBeUndefined();

		mutableContext.model = { ...ctx.model!, api: "openai-codex-responses", provider: "openai-codex" };
		modelSelect({ model: mutableContext.model }, ctx);
		expect(setStatus).toHaveBeenLastCalledWith("codex-fast", "fast");
		expect(beforeProviderRequest(event, ctx)).toEqual({ model: "test-model", service_tier: "priority" });
	});

	it("preserves fast mode after warning about a non-object Codex request payload", async () => {
		const { beforeProviderRequest, command, ctx, notify, setStatus } = createHarness();
		await command.handler("on", ctx);
		const invalidEvent = { payload: "unexpected", type: "before_provider_request" } as BeforeProviderRequestEvent;
		const validEvent = {
			payload: { model: "test-model" },
			type: "before_provider_request",
		} as BeforeProviderRequestEvent;

		expect(beforeProviderRequest(invalidEvent, ctx)).toBeUndefined();
		expect(notify).toHaveBeenLastCalledWith("Fast mode skipped: provider payload is not an object", "warning");
		expect(setStatus).not.toHaveBeenCalledWith("codex-fast", undefined);
		expect(beforeProviderRequest(validEvent, ctx)).toEqual({ model: "test-model", service_tier: "priority" });
	});

	it("shares live main-thread fast mode with child runtimes", async () => {
		const authority = { enabled: false };
		const main = createHarness("openai-codex", authority);
		const child = createHarness("openai-codex", authority, true);
		const event = { payload: { model: "test-model" }, type: "before_provider_request" } as BeforeProviderRequestEvent;

		expect(child.beforeProviderRequest(event, child.ctx)).toBeUndefined();
		await main.command.handler("on", main.ctx);
		expect(child.beforeProviderRequest(event, child.ctx)).toEqual({
			model: "test-model",
			service_tier: "priority",
		});
		await main.command.handler("off", main.ctx);
		expect(child.beforeProviderRequest(event, child.ctx)).toBeUndefined();
	});

	it("prevents child commands from changing main-thread fast mode", async () => {
		const authority = { enabled: true };
		const main = createHarness("openai-codex", authority);
		const child = createHarness("openai-codex", authority, true);
		const event = { payload: { model: "test-model" }, type: "before_provider_request" } as BeforeProviderRequestEvent;

		await child.command.handler("off", child.ctx);

		expect(child.notify).toHaveBeenLastCalledWith("Fast mode is controlled by the main thread", "warning");
		expect(main.beforeProviderRequest(event, main.ctx)).toEqual({
			model: "test-model",
			service_tier: "priority",
		});
	});

	it("resets shared fast mode when the main session starts without letting child startup reset it", async () => {
		const authority = { enabled: true };
		const main = createHarness("openai-codex", authority);
		const child = createHarness("openai-codex", authority, true);
		if (!main.sessionStart || !child.sessionStart) throw new Error("session_start handler was not registered");

		child.sessionStart({ type: "session_start" }, child.ctx);
		expect(authority.enabled).toBe(true);
		main.sessionStart({ type: "session_start" }, main.ctx);
		expect(authority.enabled).toBe(false);
	});

	it("starts disabled when the runtime extension is recreated without shared authority", async () => {
		const first = createHarness();
		await first.command.handler("on", first.ctx);
		const second = createHarness();
		const event = { payload: { model: "test-model" }, type: "before_provider_request" } as BeforeProviderRequestEvent;

		expect(second.beforeProviderRequest(event, second.ctx)).toBeUndefined();
	});
});
