import { describe, expect, it, vi } from "vitest";
import codexDaybreakExtension from "../extensions/codex-daybreak/src/index.ts";
import type {
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
	SessionStartEvent,
} from "../src/core/extensions/types.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

type BeforeProviderRequestHandler = (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => unknown;
type ModelSelectHandler = (event: { model: ExtensionContext["model"] }, ctx: ExtensionContext) => void;
type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => void;

interface DaybreakStateEntry {
	type: "custom";
	customType: string;
	data?: unknown;
}

interface DaybreakHarnessOptions {
	branch?: DaybreakStateEntry[];
	child?: boolean;
	modelId?: string;
	provider?: string;
}

function createHarness(options: DaybreakHarnessOptions = {}) {
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
	codexDaybreakExtension(pi);

	const notify = vi.fn();
	const setEditorText = vi.fn();
	const setStatus = vi.fn();
	const ctx = {
		model: {
			api: provider.startsWith("openai-codex") ? "openai-codex-responses" : "anthropic-messages",
			id: options.modelId ?? "gpt-6-sol",
			provider,
		},
		multiAgentAgentId: options.child ? "child-agent" : undefined,
		sessionManager: { getBranch: () => options.branch ?? [] },
		ui: { notify, setEditorText, setStatus },
	} as unknown as ExtensionCommandContext;
	if (!command) throw new Error("/daybreak command was not registered");
	if (!beforeProviderRequest) throw new Error("before_provider_request handler was not registered");
	if (!modelSelect) throw new Error("model_select handler was not registered");
	if (!sessionStart) throw new Error("session_start handler was not registered");
	return {
		appendEntry,
		beforeProviderRequest,
		command,
		commandName,
		ctx,
		modelSelect,
		notify,
		sessionStart,
		setEditorText,
		setStatus,
	};
}

function requestFor(model: string, extra: Record<string, unknown> = {}): BeforeProviderRequestEvent {
	return { payload: { model, ...extra }, type: "before_provider_request" } as BeforeProviderRequestEvent;
}

function setModel(ctx: ExtensionContext, id: string, provider = "openai-codex"): ExtensionContext["model"] {
	const mutable = ctx as unknown as { model: ExtensionContext["model"] };
	mutable.model = { ...ctx.model!, id, provider };
	return mutable.model;
}

describe("Codex Daybreak extension", () => {
	it("registers /daybreak as an extension command", () => {
		const { commandName } = createHarness();

		expect(commandName).toBe("daybreak");
		expect(BUILTIN_SLASH_COMMANDS.map((builtin) => builtin.name)).not.toContain("daybreak");
	});

	it("leaves requests unchanged until Blue is selected", () => {
		const { beforeProviderRequest, ctx } = createHarness();

		expect(beforeProviderRequest(requestFor("gpt-6-sol"), ctx)).toBeUndefined();
	});

	it("adds access_programs.cyber daybreak_blue to eligible Codex requests and persists the selection", async () => {
		const { appendEntry, beforeProviderRequest, command, ctx, notify, setEditorText, setStatus } = createHarness();

		await command.handler("blue", ctx);

		expect(appendEntry).toHaveBeenLastCalledWith("codex-daybreak", { cyber: "daybreak_blue" });
		expect(notify).toHaveBeenLastCalledWith("Daybreak: blue", "info");
		expect(setStatus).toHaveBeenLastCalledWith("codex-daybreak", "daybreak blue");
		expect(setEditorText).toHaveBeenLastCalledWith("");
		expect(beforeProviderRequest(requestFor("gpt-6-sol", { service_tier: "priority" }), ctx)).toEqual({
			access_programs: { cyber: "daybreak_blue" },
			model: "gpt-6-sol",
			service_tier: "priority",
		});
	});

	it("applies Blue to each eligible model and preserves other access programs", async () => {
		const { beforeProviderRequest, command, ctx } = createHarness();
		await command.handler("blue", ctx);

		for (const model of ["gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.5"]) {
			expect(beforeProviderRequest(requestFor(model), ctx)).toEqual({
				access_programs: { cyber: "daybreak_blue" },
				model,
			});
		}
		expect(beforeProviderRequest(requestFor("gpt-6-sol", { access_programs: { other: "kept" } }), ctx)).toEqual({
			access_programs: { cyber: "daybreak_blue", other: "kept" },
			model: "gpt-6-sol",
		});
	});

	it("does not send Blue for Red-only or unlisted models and marks status inactive", async () => {
		const { beforeProviderRequest, command, ctx, modelSelect, notify, setStatus } = createHarness({
			modelId: "gpt-6.1-sol",
		});

		await command.handler("blue", ctx);

		expect(notify).toHaveBeenLastCalledWith("Daybreak: blue (not applied to gpt-6.1-sol)", "warning");
		expect(setStatus).toHaveBeenLastCalledWith("codex-daybreak", "daybreak blue inactive");
		for (const model of ["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-luna"]) {
			expect(beforeProviderRequest(requestFor(model), ctx)).toBeUndefined();
		}

		modelSelect({ model: setModel(ctx, "gpt-6-luna") }, ctx);
		expect(setStatus).toHaveBeenLastCalledWith("codex-daybreak", "daybreak blue");
	});

	it("gates on the request payload model rather than the selected model", async () => {
		const { beforeProviderRequest, command, ctx } = createHarness({ modelId: "gpt-6-sol" });
		await command.handler("blue", ctx);

		expect(beforeProviderRequest(requestFor("gpt-6.1-sol"), ctx)).toBeUndefined();
		expect(
			beforeProviderRequest({ payload: {}, type: "before_provider_request" } as BeforeProviderRequestEvent, ctx),
		).toBeUndefined();
	});

	it("clears Blue with an explicit persisted off entry", async () => {
		const { appendEntry, beforeProviderRequest, command, ctx, notify, setStatus } = createHarness();
		await command.handler("blue", ctx);
		await command.handler("off", ctx);

		expect(appendEntry).toHaveBeenLastCalledWith("codex-daybreak", { cyber: null });
		expect(notify).toHaveBeenLastCalledWith("Daybreak: off", "info");
		expect(setStatus).toHaveBeenLastCalledWith("codex-daybreak", undefined);
		expect(beforeProviderRequest(requestFor("gpt-6-sol"), ctx)).toBeUndefined();
	});

	it("reports the current selection without persisting for bare /daybreak", async () => {
		const { appendEntry, command, ctx, notify } = createHarness();

		await command.handler("", ctx);

		expect(notify).toHaveBeenLastCalledWith("Daybreak: off", "info");
		expect(appendEntry).not.toHaveBeenCalled();
	});

	it("rejects unknown arguments, including red", async () => {
		const { appendEntry, command, ctx, notify } = createHarness();

		await command.handler("red", ctx);

		expect(notify).toHaveBeenLastCalledWith("Usage: /daybreak [blue|off]", "warning");
		expect(appendEntry).not.toHaveBeenCalled();
	});

	it("rejects selecting Blue on non-Codex providers and never mutates their requests", async () => {
		for (const provider of ["openai", "anthropic"]) {
			const { appendEntry, beforeProviderRequest, command, ctx, notify } = createHarness({ provider });

			await command.handler("blue", ctx);

			expect(notify).toHaveBeenLastCalledWith("Daybreak requires a Codex provider", "warning");
			expect(appendEntry).not.toHaveBeenCalled();
			expect(beforeProviderRequest(requestFor("gpt-6-sol"), ctx)).toBeUndefined();
		}
	});

	it("leaves requests unchanged after switching to a non-Codex provider", async () => {
		const { beforeProviderRequest, command, ctx, modelSelect, setStatus } = createHarness();
		await command.handler("blue", ctx);

		modelSelect({ model: setModel(ctx, "gpt-6-sol", "openai") }, ctx);

		expect(setStatus).toHaveBeenLastCalledWith("codex-daybreak", "daybreak blue inactive");
		expect(beforeProviderRequest(requestFor("gpt-6-sol"), ctx)).toBeUndefined();
	});

	it("restores the latest valid persisted selection on session start", () => {
		const restored = createHarness({
			branch: [
				{ customType: "codex-daybreak", data: { cyber: null }, type: "custom" },
				{ customType: "codex-daybreak", data: { cyber: "daybreak_blue" }, type: "custom" },
				{ customType: "codex-daybreak", data: { cyber: "daybreak_red" }, type: "custom" },
			],
		});
		restored.sessionStart({ type: "session_start" } as SessionStartEvent, restored.ctx);
		expect(restored.beforeProviderRequest(requestFor("gpt-6-sol"), restored.ctx)).toEqual({
			access_programs: { cyber: "daybreak_blue" },
			model: "gpt-6-sol",
		});
		expect(restored.setStatus).toHaveBeenLastCalledWith("codex-daybreak", "daybreak blue");

		const cleared = createHarness({
			branch: [
				{ customType: "codex-daybreak", data: { cyber: "daybreak_blue" }, type: "custom" },
				{ customType: "codex-daybreak", data: { cyber: null }, type: "custom" },
			],
		});
		cleared.sessionStart({ type: "session_start" } as SessionStartEvent, cleared.ctx);
		expect(cleared.beforeProviderRequest(requestFor("gpt-6-sol"), cleared.ctx)).toBeUndefined();
	});

	it("warns and leaves a non-object payload unchanged while keeping the selection", async () => {
		const { beforeProviderRequest, command, ctx, notify } = createHarness();
		await command.handler("blue", ctx);

		const invalid = { payload: "unexpected", type: "before_provider_request" } as BeforeProviderRequestEvent;
		expect(beforeProviderRequest(invalid, ctx)).toBeUndefined();
		expect(notify).toHaveBeenLastCalledWith("Daybreak skipped: provider payload is not an object", "warning");
		expect(beforeProviderRequest(requestFor("gpt-6-sol"), ctx)).toEqual({
			access_programs: { cyber: "daybreak_blue" },
			model: "gpt-6-sol",
		});
	});

	it("keeps child runtimes out of scope", async () => {
		const child = createHarness({
			branch: [{ customType: "codex-daybreak", data: { cyber: "daybreak_blue" }, type: "custom" }],
			child: true,
		});

		child.sessionStart({ type: "session_start" } as SessionStartEvent, child.ctx);
		await child.command.handler("blue", child.ctx);

		expect(child.notify).toHaveBeenLastCalledWith("Daybreak applies only to the main thread", "warning");
		expect(child.appendEntry).not.toHaveBeenCalled();
		expect(child.beforeProviderRequest(requestFor("gpt-6-sol"), child.ctx)).toBeUndefined();
	});
});
