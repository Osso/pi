import type { ApprovalPolicy } from "./policy.ts";

export type ApprovalPresetReviewer = "human" | "llm-deny" | "llm-ask" | "none";

export type ApprovalPreset = {
	name: string;
	label: string;
	policy: ApprovalPolicy;
	reviewer: ApprovalPresetReviewer;
};

export type SandboxProfile = {
	name: string;
	label: string;
};

export const APPROVAL_PRESETS = [
	{ name: "ask-me", label: "Ask Me", policy: "on-request", reviewer: "human" },
	{ name: "llm-approved-deny", label: "LLM Approved (and deny)", policy: "on-request", reviewer: "llm-deny" },
	{ name: "llm-approved-ask", label: "LLM Approved (and ask)", policy: "on-request", reviewer: "llm-ask" },
	{ name: "never-ask-deny", label: "Never Ask/Deny", policy: "never", reviewer: "none" },
	{ name: "auto-approve", label: "Auto Approve", policy: "auto-approve", reviewer: "none" },
] as const satisfies ReadonlyArray<ApprovalPreset>;

export type ApprovalPresetName = (typeof APPROVAL_PRESETS)[number]["name"];

export function findApprovalPreset(name: ApprovalPresetName): ApprovalPreset {
	return APPROVAL_PRESETS.find((preset) => preset.name === name)!;
}

export function isApprovalPresetName(value: unknown): value is ApprovalPresetName {
	return typeof value === "string" && APPROVAL_PRESETS.some((preset) => preset.name === value);
}

export function approvalPresetForPolicy(policy: ApprovalPolicy): ApprovalPresetName {
	if (policy === "never") {
		return "never-ask-deny";
	}

	if (policy === "auto-approve") {
		return "auto-approve";
	}

	return "ask-me";
}

export function approvalPresetToBypassPermissions(presetName: ApprovalPresetName): boolean {
	return presetName === "auto-approve";
}

export const SANDBOX_PROFILES = [
	{ name: "read-only", label: "Read Only" },
	{ name: "workspace-write", label: "Default/Workspace Write" },
	{ name: "full-access", label: "Full Access" },
] as const satisfies ReadonlyArray<SandboxProfile>;

export type SandboxProfileName = (typeof SANDBOX_PROFILES)[number]["name"];

export function isSandboxProfileName(value: unknown): value is SandboxProfileName {
	return typeof value === "string" && SANDBOX_PROFILES.some((profile) => profile.name === value);
}
