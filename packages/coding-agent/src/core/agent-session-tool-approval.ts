import type { AgentTool } from "@earendil-works/pi-agent-core";
import { reviewToolCallWithSupervisor } from "../supervisor/approval-reviewer.ts";
import type { requestSupervisorDecision } from "../supervisor/client.ts";
import { DEFAULT_SUPERVISOR_KB_DIR, resolveSupervisorProjectForCwd } from "../supervisor/project-resolver.ts";
import { sendDesktopNotification } from "./desktop-notification.ts";
import type { ExtensionRunner, ToolCallEvent, ToolCallEventResult, ToolDefinition } from "./extensions/index.ts";
import type { ApprovalReviewerResult } from "./extensions/types.ts";
import { createPermissionPromptHandler } from "./permissions/mcp-permission-prompt.ts";
import { type ApprovalReviewer, orchestrateToolApproval } from "./permissions/orchestrator.ts";
import type { PermissionRuleStore } from "./permissions/rule-store.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

const SUPERVISOR_APPROVAL_TIMEOUT_MS = 5 * 60_000;

const MCP_TOOL_NAME_PATTERN = /^mcp__[^_]+(?:_[^_]+)*__[^_]+(?:_[^_]+)*$/;
const PERMISSION_PROMPT_TOOL_NAME = "approval_prompt";
const PERMISSION_PROMPT_SCHEMA_FIELDS = ["tool_name", "input", "tool_use_id", "cwd"] as const;
const SUPERVISOR_AUTO_APPROVED_READ_ONLY_TOOLS = new Set([
	"find",
	"grep",
	"ls",
	"outline",
	"read",
	"references",
	"symbol",
]);

interface ApprovalDependencies {
	extensionRunner: ExtensionRunner;
	getExtensionRunner: () => ExtensionRunner;
	settingsManager: SettingsManager;
	getToolDefinitions: () => ReadonlyMap<string, { definition: ToolDefinition }>;
	getToolRegistry: () => ReadonlyMap<string, AgentTool>;
	permissionPromptTool: string | undefined;
	permissionRuleStore: PermissionRuleStore;
	getCwd: () => string;
	noSupervisor: boolean;
	supervisorDecisionRequester: typeof requestSupervisorDecision;
	controlDbPath: string;
	sessionManager: SessionManager;
	getMailboxAddress: () => { sessionId: string; agentId: string | null };
}

export async function reviewToolApproval(
	event: ToolCallEvent,
	messages: unknown[],
	dependencies: ApprovalDependencies,
): Promise<ToolCallEventResult | undefined> {
	const runner = dependencies.extensionRunner;
	const gateResult = await reviewToolGates(event, runner);
	if (gateResult?.block) {
		return gateResult;
	}

	const authorityResult = await runner.emitToolApprovalAuthority(event);
	if (authorityResult) return authorityResult;

	const approvalRequired = dependencies.getToolDefinitions().get(event.toolName)?.definition.approvalRequired ?? true;
	const policy = dependencies.settingsManager.getApprovalPolicy();
	const autoApproveReviewResult =
		policy === "auto-approve" ? await reviewAutoApprovedToolCall(event, runner, approvalRequired) : undefined;
	if (autoApproveReviewResult) {
		return autoApproveReviewResult;
	}

	return orchestrateToolApproval({
		policy,
		approvalRequired,
		hookReviewer: createToolApprovalHookReviewer(event, runner, dependencies),
		reviewer: createToolApprovalHumanReviewer(event, runner, dependencies),
		llmReviewer: createToolApprovalLlmReviewer(event, findLastUserText(messages), dependencies),
	});
}

async function reviewToolGates(
	event: ToolCallEvent,
	runner: ExtensionRunner,
): Promise<ToolCallEventResult | undefined> {
	if (!runner.hasToolGates()) {
		return undefined;
	}

	try {
		return await runner.emitToolGates(event);
	} catch (err) {
		if (err instanceof Error) {
			throw err;
		}
		throw new Error(`Extension failed, blocking execution: ${String(err)}`);
	}
}

async function reviewAutoApprovedToolCall(
	event: ToolCallEvent,
	runner: ExtensionRunner,
	approvalRequired: boolean,
): Promise<ToolCallEventResult | undefined> {
	if (!approvalRequired || !runner.hasApprovalReviewers()) {
		return undefined;
	}

	const reviewerResult = await runner.emitApprovalReviewers(event);
	if (reviewerResult?.action === "deny") {
		return { block: true, reason: reviewerResult.reason };
	}

	return undefined;
}

function createToolApprovalHookReviewer(
	event: ToolCallEvent,
	runner: ExtensionRunner,
	dependencies: ApprovalDependencies,
): ApprovalReviewer | undefined {
	const permissionPromptTool = resolvePermissionPromptTool(dependencies);
	if (!runner.hasApprovalReviewers() && !permissionPromptTool && !runner.hasHandlers("tool_call")) {
		return undefined;
	}

	return async () => {
		const approvalReviewerResult = await reviewRegisteredApprovalReviewers(event, runner, dependencies);
		if (approvalReviewerResult) {
			return approvalReviewerResult;
		}

		const permissionPromptResult = await createPermissionPromptHandler({
			permissionPromptTool,
			cwd: dependencies.getCwd(),
			desktopNotifier: sendDesktopNotification,
			ruleStore: dependencies.permissionRuleStore,
			callTool: async (permissionPromptTool, input) => {
				const tool = dependencies.getToolRegistry().get(permissionPromptTool);
				if (!tool) {
					throw new Error(`Permission prompt tool not found: ${permissionPromptTool}`);
				}
				return tool.execute(`permission-prompt:${input.tool_use_id}`, input as never);
			},
		})(event);
		if (permissionPromptResult !== undefined) {
			return permissionPromptResult;
		}

		if (!runner.hasHandlers("tool_call")) {
			return undefined;
		}

		try {
			return await runner.emitToolCall(event);
		} catch (err) {
			if (err instanceof Error) {
				throw err;
			}
			throw new Error(`Extension failed, blocking execution: ${String(err)}`);
		}
	};
}

async function reviewRegisteredApprovalReviewers(
	event: ToolCallEvent,
	runner: ExtensionRunner,
	dependencies: ApprovalDependencies,
): Promise<ToolCallEventResult | undefined> {
	if (!runner.hasApprovalReviewers()) {
		return undefined;
	}

	const reviewerResult = await runner.emitApprovalReviewers(event);
	return toToolCallResultFromApprovalReviewer(event, runner, reviewerResult, dependencies);
}

async function toToolCallResultFromApprovalReviewer(
	event: ToolCallEvent,
	runner: ExtensionRunner,
	reviewerResult: ApprovalReviewerResult | undefined,
	dependencies: ApprovalDependencies,
): Promise<ToolCallEventResult | undefined> {
	if (!reviewerResult) {
		return undefined;
	}
	if (reviewerResult.action === "allow") {
		return { block: false };
	}

	if (reviewerResult.action === "deny") {
		return { block: true, reason: reviewerResult.reason };
	}

	const humanReviewer = createToolApprovalHumanReviewer(event, runner, dependencies, reviewerResult.reason);
	if (!humanReviewer) {
		return { block: true, reason: reviewerResult.reason ?? "Approval required" };
	}
	return (await humanReviewer()) ?? { block: false };
}

function resolvePermissionPromptTool(dependencies: ApprovalDependencies): string | undefined {
	if (dependencies.permissionPromptTool) {
		return dependencies.permissionPromptTool;
	}

	const discoveredTools = Array.from(dependencies.getToolRegistry().values())
		.filter(isPermissionPromptProtocolTool)
		.map((tool) => tool.name);

	return discoveredTools.length === 1 ? discoveredTools[0] : undefined;
}

function createToolApprovalHumanReviewer(
	event: ToolCallEvent,
	runner: ExtensionRunner,
	dependencies: ApprovalDependencies,
	reason?: string,
	force = false,
): ApprovalReviewer | undefined {
	const approvalPreset = dependencies.settingsManager.getApprovalPreset();
	if ((!force && approvalPreset !== "ask-me" && approvalPreset !== "llm-approved-ask") || !runner.hasUI()) {
		return undefined;
	}

	return async () => {
		const reasonText = reason ? `\nReason: ${reason}` : "";
		const selection = await runner
			.getUIContext()
			.select(`Approve ${event.toolName}?${reasonText}\n${JSON.stringify(event.input, null, 2)}`, [
				"Allow once",
				"Allow always",
				"Deny",
			]);
		if (selection === "Allow once") {
			return undefined;
		}
		if (selection === "Allow always") {
			spawnAllowAlwaysAgent(event, dependencies);
			return undefined;
		}
		return { block: true, reason: "Tool call rejected by user" };
	};
}

function spawnAllowAlwaysAgent(event: ToolCallEvent, dependencies: ApprovalDependencies): void {
	const tool = dependencies.getToolRegistry().get("spawn_agent");
	if (!tool) {
		return;
	}

	void tool
		.execute(`allow-always:${event.toolCallId}`, {
			agentType: "permission-config",
			displayName: "Allow command",
			prompt: buildAllowAlwaysAgentPrompt({
				cwd: dependencies.getCwd(),
				input: event.input,
				toolName: event.toolName,
			}),
		})
		.catch((error: unknown) => {
			console.error("Failed to spawn allow-always agent:", error);
		});
}

function createToolApprovalLlmReviewer(
	event: ToolCallEvent,
	currentUserRequest: string | undefined,
	dependencies: ApprovalDependencies,
): ApprovalReviewer | undefined {
	const approvalPreset = dependencies.settingsManager.getApprovalPreset();
	if (approvalPreset !== "llm-approved-deny" && approvalPreset !== "llm-approved-ask") return undefined;
	const approvalKind = dependencies.getToolDefinitions().get(event.toolName)?.definition.approvalKind;
	if (approvalKind === "read-only" && SUPERVISOR_AUTO_APPROVED_READ_ONLY_TOOLS.has(event.toolName)) {
		return async () => undefined;
	}

	if (dependencies.noSupervisor)
		return async () => ({ block: true, reason: "Supervisor approval is unavailable in standalone worker mode" });
	// The Supervisor session cannot review its own tool call while that call holds its turn open.
	if (
		dependencies.getMailboxAddress().sessionId ===
		dependencies.settingsManager.getMergedSettings().supervisor?.sessionId
	)
		return undefined;
	return async () => {
		const kbDir = process.env.PI_KB_DIR ?? DEFAULT_SUPERVISOR_KB_DIR;
		return reviewToolCallWithSupervisor(
			() =>
				dependencies.supervisorDecisionRequester({
					controlDbPath: dependencies.controlDbPath,
					kind: "approval_review",
					payload: {
						activeGoal: dependencies.sessionManager.getSessionGoalJson(),
						currentUserRequest,
						input: event.input,
						preset: approvalPreset,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
					},
					projectId: resolveSupervisorProjectForCwd(dependencies.getCwd(), kbDir),
					senderSessionId: dependencies.getMailboxAddress().sessionId,
					senderAgentId: dependencies.getMailboxAddress().agentId,
					timeoutMs: SUPERVISOR_APPROVAL_TIMEOUT_MS,
				}),
			async (reason) => {
				const humanReviewer = createToolApprovalHumanReviewer(
					event,
					dependencies.getExtensionRunner(),
					dependencies,
					reason,
					true,
				);
				return humanReviewer ? await humanReviewer() : { block: true, reason };
			},
			approvalPreset === "llm-approved-ask",
		);
	};
}

function findLastUserText(messages: unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) continue;
		return message.content
			.filter(
				(part): part is { text: string; type: "text" } =>
					isRecord(part) && part.type === "text" && typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("");
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPermissionPromptProtocolTool(tool: AgentTool): boolean {
	if (!MCP_TOOL_NAME_PATTERN.test(tool.name)) {
		return false;
	}

	const toolName = tool.name.split("__")[2];
	return toolName === PERMISSION_PROMPT_TOOL_NAME && hasPermissionPromptSchema(tool.parameters);
}

function hasPermissionPromptSchema(parameters: unknown): boolean {
	const schema = toRecord(parameters);
	const properties = toRecord(schema?.properties);
	return PERMISSION_PROMPT_SCHEMA_FIELDS.every((field) => properties !== undefined && field in properties);
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}

	return value as Record<string, unknown>;
}

function buildAllowAlwaysAgentPrompt(input: { cwd: string; input: Record<string, unknown>; toolName: string }): string {
	return [
		"Add a persistent allow rule for a command that was approved with Allow always in Pi.",
		"",
		"Target project: /syncthing/Sync/Projects/claude/claude-bash-hook",
		`Original cwd: ${input.cwd}`,
		`Tool name: ${input.toolName}`,
		"Tool input:",
		JSON.stringify(input.input, null, 2),
		"",
		"Requirements:",
		"- Add the narrowest safe allow rule for this exact workflow.",
		"- Do not broaden access beyond what the approved command requires.",
		"- Preserve deny/protected-path precedence.",
		"- Run the relevant claude-bash-hook tests/checks.",
		"- Commit the verified config or code change if repository rules allow committing.",
	].join("\n");
}
