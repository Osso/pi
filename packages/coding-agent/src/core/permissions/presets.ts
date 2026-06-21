import type { ApprovalPolicy } from "./policy.ts";

export type ApprovalPresetReviewer = "human" | "llm" | "none";

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

export const APPROVAL_PRESETS: ReadonlyArray<ApprovalPreset> = [
	{ name: "ask-me", label: "Ask Me", policy: "on-request", reviewer: "human" },
	{ name: "llm-approved", label: "LLM Approved", policy: "on-request", reviewer: "llm" },
	{ name: "never-ask-deny", label: "Never Ask/Deny", policy: "never", reviewer: "none" },
	{ name: "auto-approve", label: "Auto Approve", policy: "auto-approve", reviewer: "none" },
];

export const SANDBOX_PROFILES: ReadonlyArray<SandboxProfile> = [
	{ name: "read-only", label: "Read Only" },
	{ name: "workspace-write", label: "Default/Workspace Write" },
	{ name: "full-access", label: "Full Access" },
];
