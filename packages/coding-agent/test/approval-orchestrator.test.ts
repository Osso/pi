import { describe, expect, it, vi } from "vitest";
import { orchestrateToolApproval } from "../src/core/permissions/orchestrator.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

describe("orchestrateToolApproval", () => {
	it("routes on-request approvals to the hook reviewer", async () => {
		const reviewer = vi.fn().mockResolvedValue({ block: true, reason: "blocked" });

		await expect(
			orchestrateToolApproval({
				approvalRequired: true,
				policy: "on-request",
				reviewer,
			}),
		).resolves.toEqual({ block: true, reason: "blocked" });
		expect(reviewer).toHaveBeenCalledTimes(1);
	});

	it("blocks never without invoking the hook reviewer", async () => {
		const reviewer = vi.fn().mockResolvedValue(undefined);

		await expect(
			orchestrateToolApproval({
				approvalRequired: true,
				policy: "never",
				reviewer,
			}),
		).resolves.toEqual({ block: true, reason: "Blocked by approval policy: never" });
		expect(reviewer).not.toHaveBeenCalled();
	});

	it("allows auto-approve without invoking the hook reviewer", async () => {
		const reviewer = vi.fn().mockResolvedValue({ block: true, reason: "blocked" });

		await expect(
			orchestrateToolApproval({
				approvalRequired: true,
				policy: "auto-approve",
				reviewer,
			}),
		).resolves.toBeUndefined();
		expect(reviewer).not.toHaveBeenCalled();
	});

	it.each([
		["read", createReadToolDefinition],
		["grep", createGrepToolDefinition],
	])("allows the built-in %s tool without requesting approval", async (_name, createToolDefinition) => {
		const reviewer = vi.fn().mockResolvedValue({ block: true, reason: "blocked" });
		const toolDefinition = createToolDefinition(process.cwd());

		await expect(
			orchestrateToolApproval({
				approvalRequired: toolDefinition.approvalRequired ?? true,
				policy: "on-request",
				reviewer,
			}),
		).resolves.toBeUndefined();
		expect(reviewer).not.toHaveBeenCalled();
	});

	it("allows non-approval-required actions without invoking any reviewer", async () => {
		const hookReviewer = vi.fn().mockResolvedValue({ block: true, reason: "hook blocked" });
		const reviewer = vi.fn().mockResolvedValue({ block: true, reason: "reviewer blocked" });
		const llmReviewer = vi.fn().mockResolvedValue({ block: true, reason: "llm blocked" });

		await expect(
			orchestrateToolApproval({
				approvalRequired: false,
				hookReviewer,
				llmReviewer,
				policy: "on-request",
				reviewer,
			}),
		).resolves.toBeUndefined();
		expect(hookReviewer).not.toHaveBeenCalled();
		expect(reviewer).not.toHaveBeenCalled();
		expect(llmReviewer).not.toHaveBeenCalled();
	});

	it("skips the LLM reviewer when a hook reviewer explicitly allows", async () => {
		const hookReviewer = vi.fn().mockResolvedValue({ block: false });
		const llmReviewer = vi.fn().mockResolvedValue({ block: true, reason: "llm blocked" });

		await expect(
			orchestrateToolApproval({
				approvalRequired: true,
				hookReviewer,
				llmReviewer,
				policy: "on-request",
			}),
		).resolves.toEqual({ block: false });
		expect(hookReviewer).toHaveBeenCalledTimes(1);
		expect(llmReviewer).not.toHaveBeenCalled();
	});

	it("falls through to the LLM reviewer when hooks return no decision", async () => {
		const hookReviewer = vi.fn().mockResolvedValue(undefined);
		const llmReviewer = vi.fn().mockResolvedValue({ block: true, reason: "llm blocked" });

		await expect(
			orchestrateToolApproval({
				approvalRequired: true,
				hookReviewer,
				llmReviewer,
				policy: "on-request",
			}),
		).resolves.toEqual({ block: true, reason: "llm blocked" });
		expect(hookReviewer).toHaveBeenCalledTimes(1);
		expect(llmReviewer).toHaveBeenCalledTimes(1);
	});

	it("skips the LLM reviewer when a hook reviewer blocks", async () => {
		const hookReviewer = vi.fn().mockResolvedValue({ block: true, reason: "hook blocked" });
		const llmReviewer = vi.fn().mockResolvedValue(undefined);

		await expect(
			orchestrateToolApproval({
				approvalRequired: true,
				hookReviewer,
				llmReviewer,
				policy: "on-request",
			}),
		).resolves.toEqual({ block: true, reason: "hook blocked" });
		expect(hookReviewer).toHaveBeenCalledTimes(1);
		expect(llmReviewer).not.toHaveBeenCalled();
	});

	it("uses the LLM reviewer when no hook reviewer is available", async () => {
		const llmReviewer = vi.fn().mockResolvedValue({ block: true, reason: "llm blocked" });

		await expect(
			orchestrateToolApproval({
				approvalRequired: true,
				llmReviewer,
				policy: "on-request",
			}),
		).resolves.toEqual({ block: true, reason: "llm blocked" });
		expect(llmReviewer).toHaveBeenCalledTimes(1);
	});
});
