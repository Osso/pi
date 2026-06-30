import { describe, expect, it } from "vitest";
import { buildAutoReviewerPrompt, parseAutoReviewerDecision } from "../src/core/permissions/auto-reviewer.ts";

describe("approval auto reviewer", () => {
	it("builds a guardian prompt with the tool call context and JSON-only response contract", () => {
		const prompt = buildAutoReviewerPrompt({
			cwd: "/repo/project",
			input: { command: "npm run check", timeoutMs: 120_000 },
			toolCallId: "tool-call-1",
			toolName: "bash",
		});

		expect(prompt).toContain("tool-call-1");
		expect(prompt).toContain("bash");
		expect(prompt).toContain("/repo/project");
		expect(prompt).toContain('"command": "npm run check"');
		expect(prompt).toContain('"timeoutMs": 120000');
		expect(prompt).toContain('{"behavior":"allow"}');
		expect(prompt).toContain('{"behavior":"deny","message":"');
		expect(prompt).toContain("Approve ordinary bounded-risk coding-agent work");
		expect(prompt).toContain("Allow temporary workspace or cache cleanup, including deleting files under /tmp");
		expect(prompt).toContain("Deny only actions likely to trash the laptop");
		expect(prompt).toContain("expose credentials");
		expect(prompt).toContain("unrelated external side effects");
	});

	it("parses allow responses from direct JSON and text content", () => {
		expect(parseAutoReviewerDecision({ behavior: "allow" })).toEqual({ behavior: "allow" });
		expect(
			parseAutoReviewerDecision({
				content: [{ type: "text", text: '{"behavior":"allow"}' }],
			}),
		).toEqual({ behavior: "allow" });
	});

	it("parses deny responses with a non-empty message", () => {
		expect(parseAutoReviewerDecision({ behavior: "deny", message: "destructive command" })).toEqual({
			behavior: "deny",
			message: "destructive command",
		});
	});

	it("rejects malformed reviewer responses", () => {
		expect(parseAutoReviewerDecision("not json")).toBeUndefined();
		expect(parseAutoReviewerDecision({ behavior: "deny", message: "" })).toBeUndefined();
		expect(parseAutoReviewerDecision({ behavior: "rewrite", message: "try this instead" })).toBeUndefined();
		expect(parseAutoReviewerDecision({ content: [{ type: "image", text: '{"behavior":"allow"}' }] })).toBeUndefined();
	});
});
