import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	onGetEntries?: () => void;
	onGetSessionName?: () => void;
	onGetContextUsage?: () => void;
}): AgentSession {
	const usage = options.usage;
	const entries =
		usage === undefined
			? []
			: [
					{
						type: "message",
						message: {
							role: "assistant",
							usage,
						},
					},
				];

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => {
				options.onGetEntries?.();
				return entries;
			},
			getSessionName: () => {
				options.onGetSessionName?.();
				return options.sessionName;
			},
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => {
			options.onGetContextUsage?.();
			return { contextWindow: 200_000, percent: 12.3 };
		},
		modelRegistry: {
			isUsingOAuth: () => false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number, executableName?: string): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExecutableName: () => executableName,
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows the executable name when available", () => {
		const session = createSession({ sessionName: "" });
		const footer = new FooterComponent(session, createFooterData(1, "pi-dev"));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("[pi-dev]");
	});

	it("reuses session-wide footer data until the footer is invalidated", () => {
		let entryReads = 0;
		let sessionNameReads = 0;
		let contextUsageReads = 0;
		const session = createSession({
			sessionName: "",
			onGetEntries: () => entryReads++,
			onGetSessionName: () => sessionNameReads++,
			onGetContextUsage: () => contextUsageReads++,
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 0.001 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		footer.render(120);
		footer.render(80);
		expect(entryReads).toBe(1);
		expect(sessionNameReads).toBe(1);
		expect(contextUsageReads).toBe(1);

		footer.invalidate();
		footer.render(120);
		expect(entryReads).toBe(2);
		expect(sessionNameReads).toBe(2);
		expect(contextUsageReads).toBe(2);
	});

	it("clears cached session data when the session changes", () => {
		let firstSessionReads = 0;
		let secondSessionReads = 0;
		const firstSession = createSession({ sessionName: "", onGetEntries: () => firstSessionReads++ });
		const secondSession = createSession({ sessionName: "", onGetEntries: () => secondSessionReads++ });
		const footer = new FooterComponent(firstSession, createFooterData(1));

		footer.render(120);
		footer.setSession(secondSession);
		footer.render(120);

		expect(firstSessionReads).toBe(1);
		expect(secondSessionReads).toBe(1);
	});

	it("shows the latest cache hit rate when cache usage is present", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 0.001 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("CH25.0%");
	});

	it("shows effort next to reasoning models", () => {
		const session = createSession({
			sessionName: "",
			modelId: "effort-model",
			reasoning: true,
			thinkingLevel: "medium",
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("effort-model • effort medium");
	});
});
