import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import defaultFooterExtension, {
	countDefaultFooterAgents,
	createDefaultFooterComponent,
	type DefaultFooterAgentLifecycleCounts,
} from "../extensions/default-footer/src/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import type { FooterSessionOverride, ReadonlyFooterDataProvider } from "../src/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { legacyMultiAgentStore } from "./helpers/legacy-multi-agent-store.ts";

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
		getThinkingLevel: () => "off",
	} as unknown as ExtensionContext;
}

function createFooterData(executableName?: string): ReadonlyFooterDataProvider {
	return {
		getAvailableProviderCount: () => 1,
		getExecutableName: () => executableName,
		getExtensionStatuses: () => new Map<string, string>(),
		getGitBranch: () => "main",
		getSessionOverride: () => undefined,
		onBranchChange: () => () => {},
	};
}

function renderedStatsLine(
	counts?: DefaultFooterAgentLifecycleCounts,
	usingOAuth = false,
	executableName?: string,
	width = 160,
): string {
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
	return footer.render(width)[1] ?? "";
}

function statsLine(counts?: DefaultFooterAgentLifecycleCounts, usingOAuth = false, executableName?: string): string {
	return stripAnsi(renderedStatsLine(counts, usingOAuth, executableName));
}

describe("default footer extension", () => {
	it("uses readable labels and omits cache and auto fields", () => {
		const line = statsLine({ running: 2, steeringPending: 1, waitingForInput: 3 });

		expect(line).toContain("agents 6");
		expect(line).not.toContain("running");
		expect(line).not.toContain("waiting");
		expect(line).not.toContain("steering");
		expect(line).toContain("in 412k out 33k cost $9.39 ctx 60.9%/272k");
		expect(line).not.toContain("R13M");
		expect(line).not.toContain("CH99.6%");
		expect(line).not.toContain("auto");
	});

	it("highlights the total active-agent count without changing surrounding footer text", () => {
		const line = renderedStatsLine({ running: 2, steeringPending: 1, waitingForInput: 3 });

		expect(line).toContain(`agents 6 ${theme.fg("dim", "in 412k")}`);
		expect(stripAnsi(line)).toContain("agents 6 in 412k");
	});

	it("highlights only the context percentage without changing surrounding footer text", () => {
		const line = renderedStatsLine();

		expect(line).toContain(`${theme.fg("dim", "ctx ")}60.9%${theme.fg("dim", "/272k")}`);
		expect(stripAnsi(line)).toContain("cost $9.39 ctx 60.9%/272k");
	});

	it("keeps unknown context usage fully dimmed", () => {
		initTheme(undefined, false);
		const footer = createDefaultFooterComponent({
			ctx: {
				...createContext({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }),
				getContextUsage: () => ({ contextWindow: 272_000, percent: undefined }),
			} as unknown as ExtensionContext,
			footerData: createFooterData(),
			theme,
		});
		const line = footer.render(160)[1] ?? "";

		expect(line).toContain(theme.fg("dim", "ctx ?/272k"));
		expect(stripAnsi(line)).toContain("ctx ?/272k");
	});

	it("keeps highlighted stats within narrow footer widths", () => {
		const line = renderedStatsLine({ running: 2, steeringPending: 1, waitingForInput: 3 }, false, undefined, 24);

		expect(visibleWidth(line)).toBeLessThanOrEqual(24);
		expect(stripAnsi(line)).toContain("agents 6");
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
		legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Running",
			permission: { narrowed: true, policy: "on-request" },
		});

		expect(countDefaultFooterAgents(store)).toEqual({ running: 1, steeringPending: 0, waitingForInput: 0 });
	});

	it("shows the selected agent slot and state in the default footer", () => {
		initTheme(undefined, false);
		const store = new MultiAgentStore({ now: () => "2026-06-27T00:00:00.000Z" });
		legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "First",
			permission: { narrowed: true, policy: "on-request" },
			slot: { index: 1, pinned: true },
		});
		const second = legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Second",
			permission: { narrowed: true, policy: "on-request" },
			slot: { index: 2, pinned: true },
		}).agent;
		const waiting = legacyMultiAgentStore(store).transitionAgent(second.id, second.revision, "waiting_for_input");
		expect(waiting.ok).toBe(true);
		store.selectAgentSlot(2);

		let footerFactory: Parameters<ExtensionContext["ui"]["setDefaultFooter"]>[0] | undefined;
		const pi = {
			on: (_eventName: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
				void handler(undefined, {
					...createContext({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }),
					ui: {
						setDefaultFooter: (factory: NonNullable<typeof footerFactory>) => {
							footerFactory = factory;
						},
					},
				} as ExtensionContext);
			},
		} as ExtensionAPI;

		defaultFooterExtension(pi, { multiAgentStore: store });
		expect(footerFactory).toBeDefined();
		const component = footerFactory?.(
			{ requestRender() {} } as Parameters<NonNullable<typeof footerFactory>>[0],
			theme,
			createFooterData(),
		);
		const line = stripAnsi(component?.render(160)[1] ?? "");

		expect(line).toContain("selected #2 Second waiting for input");
	});

	it("renders selected child session data and restores the main session", () => {
		initTheme(undefined, false);
		let override: ReturnType<ReadonlyFooterDataProvider["getSessionOverride"]>;
		const footerData: ReadonlyFooterDataProvider = {
			...createFooterData(),
			getSessionOverride: () => override,
		};
		const footer = createDefaultFooterComponent({
			ctx: createContext({ input: 11, output: 7, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } }),
			footerData,
			theme,
		});

		override = {
			cwd: "/tmp/child",
			sessionManager: {
				getCwd: () => "/tmp/child",
				getEntries: () => [
					{
						type: "message",
						message: {
							role: "assistant",
							usage: { input: 23, output: 19, cacheRead: 0, cacheWrite: 0, cost: { total: 2 } },
						},
					},
				],
				getSessionName: () => "child",
			} as unknown as FooterSessionOverride["sessionManager"],
			model: {
				id: "child-model",
				provider: "child",
				contextWindow: 100_000,
				reasoning: true,
			} as unknown as FooterSessionOverride["model"],
			thinkingLevel: "high",
			contextUsage: { contextWindow: 100_000, percent: 25, tokens: 25_000 },
		};

		const childOutput = stripAnsi(footer.render(160).join("\n"));
		expect(childOutput).toContain("/tmp/child • child");
		expect(childOutput).not.toContain("/tmp/child (main)");
		expect(childOutput).toContain("in 23 out 19 cost $2.00 ctx 25.0%/100k");
		expect(childOutput).toContain("child-model • effort high");
		expect(childOutput).not.toContain("test-model");

		override = undefined;
		const mainOutput = stripAnsi(footer.render(160).join("\n"));
		expect(mainOutput).toContain("/tmp/project (main)");
		expect(mainOutput).toContain("test-model");
		expect(mainOutput).not.toContain("child-model");
	});

	it("shows effort next to reasoning models", () => {
		initTheme(undefined, false);
		const footer = createDefaultFooterComponent({
			ctx: {
				...createContext({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }),
				model: { id: "reasoner", provider: "test", contextWindow: 200_000, reasoning: true },
				getThinkingLevel: () => "high",
			} as unknown as ExtensionContext,
			footerData: createFooterData(),
			theme,
		});

		const line = stripAnsi(footer.render(120)[1] ?? "");
		expect(line).toContain("reasoner • effort high");
	});
});
