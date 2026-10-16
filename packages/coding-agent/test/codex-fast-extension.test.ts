import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDefaultFooterComponent } from "../extensions/default-footer/src/index.ts";
import codexFastExtension from "../extensions/codex-fast/src/index.ts";
import type {
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
	SessionStartEvent,
} from "../src/core/extensions/types.ts";
import { FooterDataProvider, type FooterSessionOverride } from "../src/core/footer-data-provider.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type BeforeProviderRequestHandler = (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => unknown;
type ModelSelectHandler = (event: { model: ExtensionContext["model"] }, ctx: ExtensionContext) => void;
type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => void;

interface FastModeAuthority {
	serviceTier: "priority" | "ultrafast" | undefined;
}

interface FastStateEntry {
	type: "custom";
	customType: string;
	data?: unknown;
}

interface FastHarnessOptions {
	authority?: FastModeAuthority;
	branch?: FastStateEntry[];
	child?: boolean;
	defaultCodexFastMode?: "priority" | "ultrafast";
	historicalSubagent?: boolean;
	provider?: string;
}

function createHarness(options: FastHarnessOptions = {}) {
	const authority = options.authority ?? { serviceTier: undefined };
	const provider = options.provider ?? "openai-codex";
	let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
	let commandName: string | undefined;
	let beforeProviderRequest: BeforeProviderRequestHandler | undefined;
	let modelSelect: ModelSelectHandler | undefined;
	let sessionStart: SessionStartHandler | undefined;
	const appendEntry = vi.fn();
	const pi = {
		appendEntry,
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
	codexFastExtension(pi, { authority });

	const notify = vi.fn();
	const setEditorText = vi.fn();
	const footerData = new FooterDataProvider("/tmp/pi-codex-fast-footer-test");
	onTestFinished(() => footerData.dispose());
	const setStatus: ExtensionCommandContext["ui"]["setStatus"] = (key, status) =>
		footerData.setExtensionStatus(key, status);
	const ctx = {
		model: {
			api: provider.startsWith("openai-codex") ? "openai-codex-responses" : "anthropic-messages",
			id: "test-model",
			provider,
		},
		multiAgentAgentId: options.child ? "child-agent" : undefined,
		sessionManager: {
			getBranch: () => options.branch ?? [],
			getCwd: () => "/tmp/pi-codex-fast-footer-test",
			getEntries: () => [],
			getSessionName: () => "",
			isSubagentSession: () => options.historicalSubagent === true,
		},
		settingsManager: {
			getMergedSettings: () => ({ defaultCodexFastMode: options.defaultCodexFastMode }),
		},
		getContextUsage: () => undefined,
		getThinkingLevel: () => "off",
		ui: { notify, setEditorText, setStatus },
	} as unknown as ExtensionCommandContext;
	if (!command) throw new Error("/fast command was not registered");
	if (!beforeProviderRequest) throw new Error("before_provider_request handler was not registered");
	if (!modelSelect) throw new Error("model_select handler was not registered");
	return {
		appendEntry,
		authority,
		beforeProviderRequest,
		command,
		commandName,
		ctx,
		footerData,
		modelSelect,
		notify,
		sessionStart,
		setEditorText,
	};
}

describe("Codex fast mode extension", () => {
	it("keeps /fast out of built-in slash commands", () => {
		expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).not.toContain("fast");
	});

	it("toggles priority mode and footer status for the current runtime", async () => {
		const { command, commandName, ctx, footerData, notify, setEditorText } = createHarness();

		expect(commandName).toBe("fast");

		await command.handler("", ctx);
		expect(notify).toHaveBeenLastCalledWith("Fast mode: on", "info");
		expect(footerData.getExtensionStatuses().get("codex-fast")).toBe("fast");

		await command.handler("", ctx);
		expect(notify).toHaveBeenLastCalledWith("Fast mode: off", "info");
		expect(footerData.getExtensionStatuses().get("codex-fast")).toBeUndefined();
		expect(setEditorText).toHaveBeenCalledTimes(2);
	});

	it("supports and persists explicit on and off arguments", async () => {
		const { appendEntry, command, ctx, notify } = createHarness({ provider: "openai-codex-gc" });

		await command.handler("on", ctx);
		await command.handler("off", ctx);

		expect(notify).toHaveBeenNthCalledWith(1, "Fast mode: on", "info");
		expect(notify).toHaveBeenNthCalledWith(2, "Fast mode: off", "info");
		expect(appendEntry).toHaveBeenNthCalledWith(1, "codex-fast-mode", { serviceTier: "priority" });
		expect(appendEntry).toHaveBeenNthCalledWith(2, "codex-fast-mode", { serviceTier: null });
	});

	it("enables fast mode and annotates requests for the team provider", async () => {
		const { beforeProviderRequest, command, ctx, footerData, notify } = createHarness({
			provider: "openai-codex-team",
		});
		const event = { payload: { model: "test-model" }, type: "before_provider_request" } as BeforeProviderRequestEvent;

		await command.handler("on", ctx);

		expect(notify).toHaveBeenLastCalledWith("Fast mode: on", "info");
		expect(footerData.getExtensionStatuses().get("codex-fast")).toBe("fast");
		expect(beforeProviderRequest(event, ctx)).toEqual({ model: "test-model", service_tier: "priority" });
	});

	it("selects ultrafast processing until fast mode is disabled", async () => {
		const { beforeProviderRequest, command, ctx, footerData, notify } = createHarness();
		const event = { payload: { model: "test-model" }, type: "before_provider_request" } as BeforeProviderRequestEvent;

		await command.handler("ultra", ctx);

		expect(notify).toHaveBeenLastCalledWith("Fast mode: ultra", "info");
		expect(footerData.getExtensionStatuses().get("codex-fast")).toBe("fast ultra");
		expect(beforeProviderRequest(event, ctx)).toEqual({
			model: "test-model",
			service_tier: "ultrafast",
		});

		await command.handler("off", ctx);
		expect(beforeProviderRequest(event, ctx)).toBeUndefined();
	});

	it("rejects enabling fast mode for unsupported providers", async () => {
		const { command, ctx, footerData, notify } = createHarness({ provider: "anthropic" });

		await command.handler("on", ctx);

		expect(notify).toHaveBeenCalledWith("Fast mode requires a Codex provider", "warning");
		expect(footerData.getExtensionStatuses().get("codex-fast")).toBeUndefined();
	});

	it("rejects ordinary OpenAI providers", async () => {
		const { command, ctx, notify } = createHarness({ provider: "openai" });

		await command.handler("on", ctx);

		expect(notify).toHaveBeenCalledWith("Fast mode requires a Codex provider", "warning");
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
		const { beforeProviderRequest, command, ctx, footerData, modelSelect } = createHarness();
		const event = { payload: { model: "test-model" }, type: "before_provider_request" } as BeforeProviderRequestEvent;
		await command.handler("on", ctx);
		const mutableContext = ctx as unknown as { model: ExtensionContext["model"] };
		mutableContext.model = { ...ctx.model!, api: "anthropic-messages", provider: "anthropic" };
		modelSelect({ model: mutableContext.model }, ctx);

		expect(footerData.getExtensionStatuses().get("codex-fast")).toBeUndefined();
		expect(beforeProviderRequest(event, ctx)).toBeUndefined();

		mutableContext.model = { ...ctx.model!, api: "openai-codex-responses", provider: "openai-codex" };
		modelSelect({ model: mutableContext.model }, ctx);
		expect(footerData.getExtensionStatuses().get("codex-fast")).toBe("fast");
		expect(beforeProviderRequest(event, ctx)).toEqual({ model: "test-model", service_tier: "priority" });
	});

	it("preserves fast mode after warning about a non-object Codex request payload", async () => {
		const { beforeProviderRequest, command, ctx, footerData, notify } = createHarness();
		await command.handler("on", ctx);
		const invalidEvent = { payload: "unexpected", type: "before_provider_request" } as BeforeProviderRequestEvent;
		const validEvent = {
			payload: { model: "test-model" },
			type: "before_provider_request",
		} as BeforeProviderRequestEvent;

		expect(beforeProviderRequest(invalidEvent, ctx)).toBeUndefined();
		expect(notify).toHaveBeenLastCalledWith("Fast mode skipped: provider payload is not an object", "warning");
		expect(footerData.getExtensionStatuses().get("codex-fast")).toBe("fast");
		expect(beforeProviderRequest(validEvent, ctx)).toEqual({ model: "test-model", service_tier: "priority" });
	});

	it("shares live main-thread fast mode with child runtimes", async () => {
		const authority: FastModeAuthority = { serviceTier: undefined };
		const main = createHarness({ authority });
		const child = createHarness({ authority, child: true });
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
		const authority: FastModeAuthority = { serviceTier: "priority" };
		const main = createHarness({ authority });
		const child = createHarness({ authority, child: true });
		const event = { payload: { model: "test-model" }, type: "before_provider_request" } as BeforeProviderRequestEvent;

		await child.command.handler("off", child.ctx);

		expect(child.notify).toHaveBeenLastCalledWith("Fast mode is controlled by the main thread", "warning");
		expect(main.beforeProviderRequest(event, main.ctx)).toEqual({
			model: "test-model",
			service_tier: "priority",
		});
	});

	it("allows a main runtime with historical subagent provenance to change fast mode", async () => {
		const authority: FastModeAuthority = { serviceTier: undefined };
		const main = createHarness({ authority, historicalSubagent: true });

		await main.command.handler("on", main.ctx);

		expect(authority.serviceTier).toBe("priority");
		expect(main.notify).toHaveBeenLastCalledWith("Fast mode: on", "info");
	});
});

describe("Codex fast mode selected-agent footer", () => {
	it.each(["priority", "ultrafast"] as const)(
		"shows effective %s processing for a Codex child under an Opus main",
		(serviceTier) => {
			initTheme(undefined, false);
			const main = createHarness({ provider: "anthropic", defaultCodexFastMode: serviceTier });
			const child = createHarness({ authority: main.authority, child: true });
			if (!main.sessionStart) throw new Error("session_start handler was not registered");
			main.sessionStart({ reason: "startup", type: "session_start" }, main.ctx);
			const footer = createDefaultFooterComponent({ ctx: main.ctx, footerData: main.footerData, theme });
			const output = () => footer.render(160).map(stripAnsi).slice(2);
			const childView: FooterSessionOverride = {
				cwd: "/tmp/child",
				sessionManager: null,
				model: child.ctx.model ?? null,
				thinkingLevel: "medium",
				contextUsage: undefined,
			};
			const event = {
				payload: { model: "test-model" },
				type: "before_provider_request",
			} as BeforeProviderRequestEvent;

			expect(output()).toEqual([]);
			expect(main.beforeProviderRequest(event, main.ctx)).toBeUndefined();
			main.footerData.setSessionOverride(childView);
			expect(output()).toEqual([serviceTier === "ultrafast" ? "fast ultra" : "fast"]);
			expect(child.beforeProviderRequest(event, child.ctx)).toEqual({
				model: "test-model",
				service_tier: serviceTier,
			});

			main.footerData.setSessionOverride({ ...childView, model: main.ctx.model ?? null });
			expect(output()).toEqual([]);
			main.footerData.setSessionOverride({ ...childView, model: null });
			expect(output()).toEqual([]);
			main.footerData.setSessionOverride(childView);
			expect(output()).toHaveLength(1);
			main.footerData.clearSessionOverride();
			expect(output()).toEqual([]);
		},
	);

	it("hides fast mode for an unsupported child and updates the selected Codex child after /fast off", async () => {
		initTheme(undefined, false);
		const main = createHarness();
		const child = createHarness({ authority: main.authority, child: true });
		const unsupportedChild = createHarness({ provider: "anthropic", child: true, authority: main.authority });
		await main.command.handler("on", main.ctx);
		const footer = createDefaultFooterComponent({ ctx: main.ctx, footerData: main.footerData, theme });
		const output = () => footer.render(160).map(stripAnsi).slice(2);
		const childView: FooterSessionOverride = {
			cwd: "/tmp/child",
			sessionManager: null,
			model: unsupportedChild.ctx.model ?? null,
			thinkingLevel: "medium",
			contextUsage: undefined,
		};
		const event = { payload: { model: "test-model" }, type: "before_provider_request" } as BeforeProviderRequestEvent;

		expect(output()).toEqual(["fast"]);
		main.footerData.setSessionOverride(childView);
		expect(output()).toEqual([]);
		expect(unsupportedChild.beforeProviderRequest(event, unsupportedChild.ctx)).toBeUndefined();
		main.footerData.setSessionOverride({ ...childView, model: null });
		expect(output()).toEqual([]);
		main.footerData.setSessionOverride({ ...childView, model: child.ctx.model ?? null });
		expect(output()).toEqual(["fast"]);
		await main.command.handler("off", main.ctx);
		expect(output()).toEqual([]);
		expect(child.beforeProviderRequest(event, child.ctx)).toBeUndefined();
		main.footerData.clearSessionOverride();
		expect(output()).toEqual([]);
	});
});

describe("Codex fast mode session startup", () => {
	it("restores the latest persisted fast mode on main session startup", () => {
		const authority: FastModeAuthority = { serviceTier: undefined };
		const branch: FastStateEntry[] = [
			{ type: "custom", customType: "codex-fast-mode", data: { serviceTier: "priority" } },
			{ type: "custom", customType: "other-state", data: { serviceTier: null } },
			{ type: "custom", customType: "codex-fast-mode", data: { serviceTier: "ultrafast" } },
		];
		const main = createHarness({ authority, branch });
		const child = createHarness({ authority, branch: [], child: true });
		if (!main.sessionStart || !child.sessionStart) throw new Error("session_start handler was not registered");

		child.sessionStart({ reason: "startup", type: "session_start" }, child.ctx);
		expect(authority.serviceTier).toBeUndefined();
		main.sessionStart({ reason: "startup", type: "session_start" }, main.ctx);
		expect(authority.serviceTier).toBe("ultrafast");
		expect(main.footerData.getExtensionStatuses().get("codex-fast")).toBe("fast ultra");
	});

	it.each(["priority", "ultrafast"] as const)(
		"applies configured %s default on main session startup without persisted fast mode",
		(serviceTier) => {
			const main = createHarness({ branch: [], defaultCodexFastMode: serviceTier });
			if (!main.sessionStart) throw new Error("session_start handler was not registered");
			main.sessionStart({ reason: "startup", type: "session_start" }, main.ctx);
			const event = {
				payload: { model: "test-model" },
				type: "before_provider_request",
			} as BeforeProviderRequestEvent;

			expect(main.authority.serviceTier).toBe(serviceTier);
			expect(main.beforeProviderRequest(event, main.ctx)).toEqual({
				model: "test-model",
				service_tier: serviceTier,
			});
		},
	);

	it("lets a persisted explicit-off entry override a configured enabled default", () => {
		const main = createHarness({
			branch: [{ type: "custom", customType: "codex-fast-mode", data: { serviceTier: null } }],
			defaultCodexFastMode: "priority",
		});
		if (!main.sessionStart) throw new Error("session_start handler was not registered");
		main.sessionStart({ reason: "startup", type: "session_start" }, main.ctx);
		const event = { payload: { model: "test-model" }, type: "before_provider_request" } as BeforeProviderRequestEvent;

		expect(main.authority.serviceTier).toBeUndefined();
		expect(main.beforeProviderRequest(event, main.ctx)).toBeUndefined();
	});

	it("starts disabled when the opened session has no persisted fast mode", async () => {
		const first = createHarness();
		await first.command.handler("on", first.ctx);
		const second = createHarness();
		if (!second.sessionStart) throw new Error("session_start handler was not registered");
		second.sessionStart({ reason: "startup", type: "session_start" }, second.ctx);
		const event = { payload: { model: "test-model" }, type: "before_provider_request" } as BeforeProviderRequestEvent;

		expect(second.authority.serviceTier).toBeUndefined();
		expect(second.beforeProviderRequest(event, second.ctx)).toBeUndefined();
	});
});
