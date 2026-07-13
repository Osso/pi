import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	test("shows the resolved worktree cwd as the current working directory", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: "/repo/project-feature",
		});

		expect(prompt).toContain("Current working directory: /repo/project-feature");
		expect(prompt).not.toContain("Current working directory: /repo/project\n");
	});

	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
					grep: "Search file contents",
					find: "Search for files by glob",
					ls: "List directory contents",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
			expect(prompt).toContain("- grep:");
			expect(prompt).toContain("- find:");
			expect(prompt).toContain("- ls:");
		});

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("command backgrounding guidelines", () => {
		test("warns that supported long-running command tools auto-background after 2 minutes when wait_agents is available", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["bash", "wait_agents"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"Supported long-running command tools such as bash and Pyrun are automatically backgrounded after 2 minutes; use wait_agents to wait for any agent completion, then inspect reported background job details or attached log files instead of assuming the command stopped.",
			);
		});

		test("omits wait_agents backgrounding instructions when wait_agents is unavailable", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["bash"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("use wait_agents to wait for any agent completion");
		});
	});

	describe("delegation guidelines", () => {
		test("requires explore agents for codebase research", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "grep", "find", "spawn_agent"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				'For codebase research, exploration, or file-reading investigation, you must use spawn_agent with agentType "explore" before direct file search, unless the user explicitly asks you not to delegate.',
			);
		});

		test("requires verifier agents before completion claims", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["spawn_agent"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				'Before claiming work is fixed, tested, passing, or complete, you must use spawn_agent with agentType "verifier" to run proof commands, unless the user explicitly asks you not to delegate.',
			);
		});

		test("recommends documentation-update agents for documentation-impacting changes", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["spawn_agent"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				'For code changes that affect user-facing behavior, public APIs, CLI output, configuration, specs, or changelog-worthy behavior, use spawn_agent with agentType "documentation-update" to audit and update relevant docs, specs, or changelogs before final completion.',
			);
		});
	});

	describe("prompt guidelines", () => {
		test("instructs models to emit independent tool calls together", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "grep", "find"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"Before making tool calls, identify all calls whose inputs are already known and independent. Emit those calls together in the same assistant response; do not serialize independent exploration calls. Only wait when a later call requires an earlier result.",
			);
		});

		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	describe("user rules", () => {
		test("wraps rules content after project context", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [{ path: "/repo/AGENTS.md", content: "Project instructions." }],
				rulesContent: "Global rule.\n\nProject rule.",
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("<project_context>");
			expect(prompt).toContain("</project_context>\n\n<user_rules>\nGlobal rule.\n\nProject rule.\n</user_rules>");
			expect(prompt.indexOf("</project_context>")).toBeLessThan(prompt.indexOf("<user_rules>"));
		});

		test("does not add empty user rules tags", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				rulesContent: undefined,
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("<user_rules>");
		});
	});
});
