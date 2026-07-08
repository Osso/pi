import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
	appendApprovalMemory,
	loadApprovalMemory,
	normalizeApprovalMemorySuggestion,
} from "../src/core/permissions/approval-memory.ts";

describe("approval memory", () => {
	it("normalizes bounded memory suggestions and rejects malformed suggestions", () => {
		expect(
			normalizeApprovalMemorySuggestion({
				decision: "allow",
				pattern: "npm run check",
				reason: "Project check is bounded validation",
				scope: "local-validation",
				toolName: "bash",
			}),
		).toEqual({
			decision: "allow",
			pattern: "npm run check",
			reason: "Project check is bounded validation",
			scope: "local-validation",
			toolName: "bash",
		});

		expect(
			normalizeApprovalMemorySuggestion({
				decision: "allow",
				pattern: "",
				reason: "x",
				scope: "x",
				toolName: "bash",
			}),
		).toBeUndefined();
		expect(
			normalizeApprovalMemorySuggestion({
				decision: "rewrite",
				pattern: "npm",
				reason: "x",
				scope: "x",
				toolName: "bash",
			}),
		).toBeUndefined();
	});

	it("appends and loads approval memory records from jsonl", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-approval-memory-"));
		const memory = {
			decision: "allow" as const,
			pattern: "npm run check",
			reason: "Project check is bounded validation",
			scope: "local-validation",
			toolName: "bash",
		};

		appendApprovalMemory(agentDir, memory);

		expect(loadApprovalMemory(agentDir)).toEqual([memory]);
		expect(readFileSync(join(agentDir, "approval-memory.jsonl"), "utf-8")).toContain('"pattern":"npm run check"');
	});
});
