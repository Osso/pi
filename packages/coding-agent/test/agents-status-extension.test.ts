import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
	collectAgentRows,
	describeAgentKind,
	MAX_AGENT_ROWS,
	renderAgentsStatus,
} from "../extensions/agents-status/src/index.ts";
import { summarizeToolArguments } from "../src/core/agent-activity-detail.ts";
import type { AgentSnapshot } from "../src/core/multi-agent-store.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const NOW_MS = Date.parse("2026-10-08T12:00:00.000Z");

function agent(overrides: Partial<AgentSnapshot> & Pick<AgentSnapshot, "id">): AgentSnapshot {
	return {
		parentId: undefined,
		displayName: overrides.id,
		agentType: "test",
		lifecycle: "running",
		revision: 1,
		createdAt: "2026-10-08T11:59:00.000Z",
		updatedAt: "2026-10-08T11:59:50.000Z",
		cwd: "/repo",
		permission: { policy: "on-request", narrowed: true },
		...overrides,
	};
}

function render(agents: AgentSnapshot[], width = 80): string[] {
	return renderAgentsStatus(agents, width, NOW_MS, theme).map(stripAnsi);
}

describe("summarizeToolArguments", () => {
	it("prefers the command and collapses it to one line", () => {
		expect(summarizeToolArguments({ command: "npm run check\n  && echo ok", timeout: 5 })).toBe(
			"npm run check && echo ok",
		);
	});

	it("falls back to path-like arguments and skips empty values", () => {
		expect(summarizeToolArguments({ command: "  ", path: "src/main.ts" })).toBe("src/main.ts");
	});

	it("truncates long values and ignores unknown argument shapes", () => {
		expect(summarizeToolArguments({ code: "x".repeat(500) })).toHaveLength(160);
		expect(summarizeToolArguments({ edits: [] })).toBeUndefined();
		expect(summarizeToolArguments(undefined)).toBeUndefined();
	});
});

describe("agents status widget", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("renders nothing without visible agents", () => {
		const finishedLongAgo = agent({ id: "old", lifecycle: "completed", updatedAt: "2026-10-08T11:00:00.000Z" });
		expect(render([finishedLongAgo])).toEqual([]);
	});

	it("shows the current tool with arguments and elapsed time on one line", () => {
		const lines = render([
			agent({
				id: "fix-footer",
				currentActivity: {
					phase: "tool",
					startedAt: "2026-10-08T11:59:48.000Z",
					toolCallId: "call-1",
					toolName: "bash",
					detail: "npm run test:coding-agent -- footer",
				},
			}),
		]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/● fix-footer {2}test {2}bash npm run test:coding-agent -- footer +12s$/);
	});

	it("truncates long activity to the terminal width", () => {
		const lines = render(
			[
				agent({
					id: "a",
					currentActivity: {
						phase: "tool",
						startedAt: "2026-10-08T11:59:59.000Z",
						toolCallId: "call-1",
						toolName: "bash",
						detail: "y".repeat(200),
					},
				}),
			],
			40,
		);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0])).toBeLessThanOrEqual(40);
		expect(lines[0]).toMatch(/1s$/);
	});

	it("orders waiting agents first and nests children under their parent", () => {
		const rows = collectAgentRows(
			[
				agent({ id: "runner" }),
				agent({
					id: "child",
					parentId: "runner",
					currentActivity: { phase: "thinking", startedAt: "2026-10-08T11:59:59.000Z" },
				}),
				agent({ id: "asker", lifecycle: "waiting_for_input" }),
			],
			NOW_MS,
		);
		expect(rows.map((row) => [row.agent.id, row.depth])).toEqual([
			["asker", 0],
			["runner", 0],
			["child", 1],
		]);
		const lines = render(rows.map((row) => row.agent));
		expect(lines[0]).toContain("waiting for input");
		expect(lines[2]).toMatch(/└ ● child +test +thinking/);
	});

	it("keeps recently finished agents briefly and reports failures", () => {
		const lines = render([
			agent({ id: "done", lifecycle: "completed", updatedAt: "2026-10-08T11:59:55.000Z" }),
			agent({
				id: "broke",
				lifecycle: "failed",
				updatedAt: "2026-10-08T11:59:58.000Z",
				error: { message: "boom" },
			}),
		]);
		expect(lines[0]).toMatch(/✗ broke +test +failed: boom +58s$/);
		expect(lines[1]).toMatch(/✓ done +test +done +55s$/);
	});

	it("shows the agent type and model id between the name and activity", () => {
		const reviewer = agent({
			id: "review",
			agentType: "reviewer",
			model: { providerId: "claude-bridge", modelId: "claude-opus-5-5" },
		});
		expect(describeAgentKind(reviewer)).toBe("reviewer · claude-opus-5-5");
		expect(describeAgentKind(agent({ id: "plain" }))).toBe("test");
		const lines = render([reviewer, agent({ id: "plain", updatedAt: "2026-10-08T11:59:40.000Z" })]);
		expect(lines[0]).toMatch(/● review {2}reviewer · claude-opus-5-5 {2}starting/);
		expect(lines[1]).toMatch(/● plain {3}test {24}starting/);
	});

	it(`caps the list at ${MAX_AGENT_ROWS} rows with an overflow line`, () => {
		const agents = Array.from({ length: 8 }, (_, index) => agent({ id: `agent-${index}` }));
		const lines = render(agents);
		expect(lines).toHaveLength(MAX_AGENT_ROWS + 1);
		expect(lines[MAX_AGENT_ROWS]).toBe(" +3 more");
	});
});
