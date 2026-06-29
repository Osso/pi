import { describe, expect, it } from "vitest";
import {
	countDefaultFooterAgents,
	createDefaultFooterComponent,
	type DefaultFooterAgentLifecycleCounts,
} from "../extensions/default-footer/src/index.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createContext(usage: AssistantUsage, usingOAuth = false): ExtensionContext {
	const entries = [
		{
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		},
	];
	return {
		model: { id: "test-model", provider: "test", contextWindow: 272_000, reasoning: false },
		modelRegistry: { isUsingOAuth: () => usingOAuth },
		sessionManager: {
			getCwd: () => "/tmp/project",
			getEntries: () => entries,
			getSessionName: () => "",
		},
		getContextUsage: () => ({ contextWindow: 272_000, percent: 60.9 }),
	} as unknown as ExtensionContext;
}

function createFooterData(executableName?: string): ReadonlyFooterDataProvider {
	return {
		getAvailableProviderCount: () => 1,
		getExecutableName: () => executableName,
		getExtensionStatuses: () => new Map<string, string>(),
		getGitBranch: () => "main",
		onBranchChange: () => () => {},
	};
}

function statsLine(counts?: DefaultFooterAgentLifecycleCounts, usingOAuth = false, executableName?: string): string {
	initTheme(undefined, false);
	const footer = createDefaultFooterComponent({
		ctx: createContext(
			{
				input: 412_000,
				output: 33_000,
				cacheRead: 13_000_000,
				cacheWrite: 0,
				cost: { total: 9.389 },
			},
			usingOAuth,
		),
		footerData: createFooterData(executableName),
		getAgentCounts: () => counts,
		theme,
	});
	return stripAnsi(footer.render(160)[1] ?? "");
}

describe("default footer extension", () => {
	it("uses readable labels and omits cache and auto fields", () => {
		const line = statsLine({ running: 2, steeringPending: 1, waitingForInput: 3 });

		expect(line).toContain("agents 2 running 3 waiting 1 steering");
		expect(line).toContain("in 412k out 33k cost $9.39 ctx 60.9%/272k");
		expect(line).not.toContain("R13M");
		expect(line).not.toContain("CH99.6%");
		expect(line).not.toContain("auto");
	});

	it("does not show subscription shorthand in cost text", () => {
		const line = statsLine(undefined, true);

		expect(line).toContain("cost $9.39");
		expect(line).not.toContain("sub");
	});

	it("omits agent counts when all tracked lifecycle counts are zero", () => {
		const line = statsLine({ running: 0, steeringPending: 0, waitingForInput: 0 });

		expect(line).not.toContain("agents");
	});

	it("shows the non-default executable name when available", () => {
		const line = statsLine(undefined, false, "pi-dev");

		expect(line).toContain("[pi-dev]");
	});

	it("does not show the default pi executable name", () => {
		const line = statsLine(undefined, false, undefined);

		expect(line).not.toContain("[pi]");
	});

	it("counts only running waiting and steering agents", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-27T00:00:00.000Z" });
		const queued = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Queued",
			permission: { narrowed: true, policy: "on-request" },
		}).agent;
		const running = store.transitionAgent(queued.id, queued.revision, "starting");
		expect(running.ok).toBe(true);
		if (!running.ok) throw new Error("expected start");
		expect(store.transitionAgent(running.agent.id, running.agent.revision, "running").ok).toBe(true);

		expect(countDefaultFooterAgents(store)).toEqual({ running: 1, steeringPending: 0, waitingForInput: 0 });
	});
});
