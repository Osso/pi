import type { Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "../../../src/core/extensions/types.ts";

const DAYBREAK_ENTRY = "codex-daybreak";
const DAYBREAK_STATUS_KEY = "codex-daybreak";
const DAYBREAK_BLUE = "daybreak_blue";
const SUPPORTED_PROVIDERS = new Set(["openai-codex", "openai-codex-gc", "openai-codex-team"]);
// Models with reduced cyber refusals under Daybreak Blue; GPT-6.1 Sol and GPT-6 Astra require Red approval.
const BLUE_ELIGIBLE_MODELS = new Set(["gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.5"]);
const USAGE = "Usage: /daybreak [blue|off]";

type DaybreakProgram = typeof DAYBREAK_BLUE;

type DaybreakEntry = {
	cyber: DaybreakProgram | null;
};

interface DaybreakState {
	cyber: DaybreakProgram | undefined;
}

type PayloadObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PayloadObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChildRuntime(ctx: ExtensionContext): boolean {
	return ctx.multiAgentAgentId !== undefined || ctx.multiAgentRequiresAgentId === true;
}

function isCodexProvider(model: Model<string> | undefined): boolean {
	return model !== undefined && SUPPORTED_PROVIDERS.has(model.provider);
}

function appliesTo(model: Model<string> | undefined): boolean {
	return model !== undefined && isCodexProvider(model) && BLUE_ELIGIBLE_MODELS.has(model.id);
}

function updateStatus(ctx: ExtensionContext, state: DaybreakState, model = ctx.model): void {
	if (!state.cyber) {
		ctx.ui.setStatus(DAYBREAK_STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(DAYBREAK_STATUS_KEY, appliesTo(model) ? "daybreak blue" : "daybreak blue inactive");
}

function readPersistedProgram(ctx: ExtensionContext): DaybreakProgram | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== DAYBREAK_ENTRY || !isPlainObject(entry.data)) continue;
		const { cyber } = entry.data;
		if (cyber === null) return undefined;
		if (cyber === DAYBREAK_BLUE) return cyber;
	}
	return undefined;
}

function notifySelection(ctx: ExtensionContext, state: DaybreakState): void {
	if (state.cyber && !appliesTo(ctx.model)) {
		ctx.ui.notify(`Daybreak: blue (not applied to ${ctx.model?.id ?? "no model"})`, "warning");
		return;
	}
	ctx.ui.notify(`Daybreak: ${state.cyber ? "blue" : "off"}`, "info");
}

function requestedProgram(args: string): DaybreakProgram | null | undefined {
	const requested = args.trim().toLowerCase();
	if (requested === "blue") return DAYBREAK_BLUE;
	if (requested === "off") return null;
	return undefined;
}

function handleDaybreakCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	state: DaybreakState,
): void {
	if (isChildRuntime(ctx)) {
		ctx.ui.notify("Daybreak applies only to the main thread", "warning");
		return;
	}
	if (!args.trim()) {
		notifySelection(ctx, state);
		return;
	}
	const requested = requestedProgram(args);
	if (requested === undefined) {
		ctx.ui.notify(USAGE, "warning");
		return;
	}
	if (requested !== null && !isCodexProvider(ctx.model)) {
		ctx.ui.notify("Daybreak requires a Codex provider", "warning");
		return;
	}
	state.cyber = requested ?? undefined;
	pi.appendEntry<DaybreakEntry>(DAYBREAK_ENTRY, { cyber: requested });
	updateStatus(ctx, state);
	notifySelection(ctx, state);
}

function withBlueAccess(payload: PayloadObject): PayloadObject {
	const accessPrograms = isPlainObject(payload.access_programs) ? payload.access_programs : {};
	return { ...payload, access_programs: { ...accessPrograms, cyber: DAYBREAK_BLUE } };
}

export default function codexDaybreakExtension(pi: ExtensionAPI): void {
	const state: DaybreakState = { cyber: undefined };
	pi.registerCommand("daybreak", {
		description: "Select the OpenAI Daybreak Blue access program for eligible Codex models in this session",
		handler: async (args, ctx) => {
			handleDaybreakCommand(args, ctx, pi, state);
			ctx.ui.setEditorText("");
		},
	});
	pi.on("session_start", (_event, ctx) => {
		if (isChildRuntime(ctx)) return;
		state.cyber = readPersistedProgram(ctx);
		updateStatus(ctx, state);
	});
	pi.on("model_select", (event, ctx) => {
		updateStatus(ctx, state, event.model);
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (!state.cyber || isChildRuntime(ctx) || !isCodexProvider(ctx.model)) return undefined;
		if (!isPlainObject(event.payload)) {
			ctx.ui.notify("Daybreak skipped: provider payload is not an object", "warning");
			return undefined;
		}
		const requestModel = event.payload.model;
		if (typeof requestModel !== "string" || !BLUE_ELIGIBLE_MODELS.has(requestModel)) return undefined;
		return withBlueAccess(event.payload);
	});
}
