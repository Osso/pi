import type { ThinkingLevel as AgentThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../../src/core/extensions/types.ts";

type MultiAgentMode = "proactive" | "explicit";

type DelegationModeEntry = {
	mode: MultiAgentMode;
};

const DELEGATION_MODE_ENTRY = "multi-agent-mode";
const DELEGATION_STATUS_KEY = "multi-agent-mode";
const POLICY_START = "<multi_agent_mode>";
const POLICY_END = "</multi_agent_mode>";

const DELEGATION_POLICIES: Record<MultiAgentMode, string> = {
	proactive:
		"Proactive multi-agent delegation is active. Use sub-agents when parallel work would materially improve speed or quality. This mode remains active until a later multi-agent mode message changes it.",
	explicit:
		"Any earlier instruction enabling proactive multi-agent delegation no longer applies. Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work.",
};

interface DelegationState {
	mode: MultiAgentMode;
}

function getEffortLevels(ctx: ExtensionCommandContext): AgentThinkingLevel[] | undefined {
	return ctx.model ? getSupportedThinkingLevels(ctx.model) : undefined;
}

function formatEffortLevels(levels: readonly AgentThinkingLevel[]): string {
	return levels.join(", ");
}

function findSelectedEffort(levels: readonly AgentThinkingLevel[], effort: string): AgentThinkingLevel | undefined {
	return levels.find((level) => level === effort.toLowerCase());
}

function clearEditor(ctx: ExtensionCommandContext): void {
	ctx.ui.setEditorText("");
}

function isChildRuntime(ctx: ExtensionContext): boolean {
	return ctx.multiAgentAgentId !== undefined || ctx.multiAgentRequiresAgentId === true;
}

function parseMultiAgentMode(value: unknown): MultiAgentMode | undefined {
	if (value === "proactive" || value === "explicit") return value;
	return undefined;
}

function restoreDelegationMode(state: DelegationState, ctx: ExtensionContext): void {
	state.mode = "proactive";
	for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
		if (entry.type !== "custom" || entry.customType !== DELEGATION_MODE_ENTRY) continue;
		const data = entry.data as DelegationModeEntry | undefined;
		const mode = parseMultiAgentMode(data?.mode);
		if (mode) state.mode = mode;
	}
}

function persistDelegationMode(pi: ExtensionAPI, state: DelegationState): void {
	pi.appendEntry<DelegationModeEntry>(DELEGATION_MODE_ENTRY, { mode: state.mode });
}

function updateDelegationStatus(ctx: ExtensionContext, state: DelegationState): void {
	ctx.ui.setStatus(DELEGATION_STATUS_KEY, `multi-agent: ${state.mode}`);
}

function policyText(mode: MultiAgentMode): string {
	return `${POLICY_START}${DELEGATION_POLICIES[mode]}${POLICY_END}`;
}

function removeDelegationPolicy(systemPrompt: string): string {
	const escapedStart = POLICY_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const escapedEnd = POLICY_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`\\n*${escapedStart}[\\s\\S]*?${escapedEnd}\\n*`, "g");
	return systemPrompt.replace(pattern, "").trimEnd();
}

function injectDelegationPolicy(systemPrompt: string, mode: MultiAgentMode): string {
	const basePrompt = removeDelegationPolicy(systemPrompt);
	const policy = policyText(mode);
	return basePrompt ? `${basePrompt}\n\n${policy}` : policy;
}

function applyDelegationMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: DelegationState,
	mode: MultiAgentMode,
): void {
	state.mode = mode;
	persistDelegationMode(pi, state);
	updateDelegationStatus(ctx, state);
}

function setDelegationMode(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	state: DelegationState,
	mode: MultiAgentMode,
): void {
	if (mode === "explicit" && ctx.getThinkingLevel() === "ultra") {
		ctx.setThinkingLevel("max");
	}
	applyDelegationMode(pi, ctx, state, mode);
	ctx.ui.notify(`Multi-agent mode: ${mode}`, "info");
	clearEditor(ctx);
}

function showInvalidMode(ctx: ExtensionCommandContext, requestedMode: string): void {
	ctx.ui.notify(`Invalid multi-agent mode "${requestedMode}". Available: proactive, explicit`, "warning");
	clearEditor(ctx);
}

async function selectDelegationMode(ctx: ExtensionCommandContext): Promise<MultiAgentMode | undefined> {
	const selectedMode = await ctx.ui.select("Select multi-agent mode", ["proactive", "explicit"]);
	return parseMultiAgentMode(selectedMode);
}

async function handleDelegationCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	state: DelegationState,
): Promise<void> {
	if (isChildRuntime(ctx)) {
		ctx.ui.notify("Multi-agent mode is controlled by the main thread", "warning");
		clearEditor(ctx);
		return;
	}

	const requestedMode = args.trim().toLowerCase();
	const mode = requestedMode ? parseMultiAgentMode(requestedMode) : await selectDelegationMode(ctx);
	if (!mode) {
		if (requestedMode) showInvalidMode(ctx, requestedMode);
		else clearEditor(ctx);
		return;
	}
	setDelegationMode(pi, ctx, state, mode);
}

function restoreAndUpdateDelegationMode(state: DelegationState, ctx: ExtensionContext): void {
	if (isChildRuntime(ctx)) return;
	restoreDelegationMode(state, ctx);
	updateDelegationStatus(ctx, state);
}

function registerDelegationControl(pi: ExtensionAPI, state: DelegationState): void {
	pi.registerCommand("multi-agent", {
		description: "Set multi-agent delegation mode",
		handler: (args, ctx) => handleDelegationCommand(args, ctx, pi, state),
	});

	pi.on("session_start", (_event, ctx) => restoreAndUpdateDelegationMode(state, ctx));
	pi.on("session_tree", (_event, ctx) => restoreAndUpdateDelegationMode(state, ctx));
	pi.on("thinking_level_select", (event, ctx) => {
		if (isChildRuntime(ctx) || event.level !== "ultra" || state.mode === "proactive") return;
		applyDelegationMode(pi, ctx, state, "proactive");
	});
	pi.on("before_agent_start", (event, ctx) => {
		if (isChildRuntime(ctx)) return;
		return { systemPrompt: injectDelegationPolicy(event.systemPrompt, state.mode) };
	});
}

function setEffort(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	state: DelegationState,
	effort: AgentThinkingLevel,
): void {
	const activatesProactiveDelegation = effort === "ultra" && !isChildRuntime(ctx);
	if (activatesProactiveDelegation) {
		applyDelegationMode(pi, ctx, state, "proactive");
	}
	ctx.setThinkingLevel(effort);
	const label = activatesProactiveDelegation ? "ultra (max + proactive)" : ctx.getThinkingLevel();
	ctx.ui.notify(`Effort: ${label}`, "info");
	clearEditor(ctx);
}

function showInvalidEffort(
	ctx: ExtensionCommandContext,
	requestedEffort: string,
	levels: readonly AgentThinkingLevel[],
): void {
	ctx.ui.notify(`Invalid effort "${requestedEffort}". Available: ${formatEffortLevels(levels)}`, "warning");
}

async function selectEffort(
	ctx: ExtensionCommandContext,
	levels: readonly AgentThinkingLevel[],
): Promise<AgentThinkingLevel | undefined> {
	const selectedEffort = await ctx.ui.select("Select effort", [...levels]);
	return selectedEffort ? findSelectedEffort(levels, selectedEffort) : undefined;
}

async function handleEffortCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	state: DelegationState,
): Promise<void> {
	const levels = getEffortLevels(ctx);
	if (!levels) {
		ctx.ui.notify("No model selected", "warning");
		clearEditor(ctx);
		return;
	}

	const requestedEffort = args.trim();
	const selectedEffort = requestedEffort
		? findSelectedEffort(levels, requestedEffort)
		: await selectEffort(ctx, levels);
	if (!selectedEffort) {
		if (requestedEffort) showInvalidEffort(ctx, requestedEffort, levels);
		clearEditor(ctx);
		return;
	}
	setEffort(pi, ctx, state, selectedEffort);
}

export default function effortExtension(pi: ExtensionAPI): void {
	const state: DelegationState = { mode: "proactive" };
	registerDelegationControl(pi, state);

	pi.registerCommand("effort", {
		description: "Set model effort level (depends on selected model)",
		handler: (args, ctx) => handleEffortCommand(args, ctx, pi, state),
	});
}
