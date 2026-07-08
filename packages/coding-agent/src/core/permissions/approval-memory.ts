import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export type ApprovalMemoryDecision = "allow" | "deny" | "ask";

export type ApprovalRecentDecision = {
	toolName: string;
	inputSummary: string;
	decision: ApprovalMemoryDecision;
	reason?: string;
};

export type ApprovalMemoryRecord = {
	toolName: string;
	pattern: string;
	decision: ApprovalMemoryDecision;
	scope: string;
	reason: string;
};

const APPROVAL_MEMORY_FILE = "approval-memory.jsonl";
const MAX_FIELD_LENGTH = 500;
const MAX_LOADED_MEMORY_RECORDS = 100;

export function getApprovalMemoryPath(agentDir: string): string {
	return join(agentDir, APPROVAL_MEMORY_FILE);
}

export function normalizeApprovalMemorySuggestion(value: unknown): ApprovalMemoryRecord | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	const toolName = normalizeField(value.toolName);
	const pattern = normalizeField(value.pattern);
	const decision = normalizeDecision(value.decision);
	const scope = normalizeField(value.scope);
	const reason = normalizeField(value.reason);
	if (!toolName || !pattern || !decision || !scope || !reason) {
		return undefined;
	}

	return { toolName, pattern, decision, scope, reason };
}

export function loadApprovalMemory(agentDir: string): ApprovalMemoryRecord[] {
	const path = getApprovalMemoryPath(agentDir);
	if (!existsSync(path)) {
		return [];
	}

	const records: ApprovalMemoryRecord[] = [];
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		const record = parseMemoryLine(line);
		if (record) {
			records.push(record);
		}
	}

	return records.slice(-MAX_LOADED_MEMORY_RECORDS);
}

export function appendApprovalMemory(agentDir: string, memory: ApprovalMemoryRecord): void {
	const normalized = normalizeApprovalMemorySuggestion(memory);
	if (!normalized) {
		return;
	}

	mkdirSync(agentDir, { recursive: true });
	writeFileSync(getApprovalMemoryPath(agentDir), `${JSON.stringify(normalized)}\n`, { flag: "a" });
}

export function summarizeToolInput(input: Record<string, unknown>): string {
	const summary = JSON.stringify(input);
	return summary.length > MAX_FIELD_LENGTH ? `${summary.slice(0, MAX_FIELD_LENGTH)}…` : summary;
}

function parseMemoryLine(line: string): ApprovalMemoryRecord | undefined {
	const trimmed = line.trim();
	if (!trimmed) {
		return undefined;
	}

	try {
		return normalizeApprovalMemorySuggestion(JSON.parse(trimmed));
	} catch {
		return undefined;
	}
}

function normalizeField(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}

	return trimmed.length > MAX_FIELD_LENGTH ? trimmed.slice(0, MAX_FIELD_LENGTH) : trimmed;
}

function normalizeDecision(value: unknown): ApprovalMemoryDecision | undefined {
	return value === "allow" || value === "deny" || value === "ask" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
