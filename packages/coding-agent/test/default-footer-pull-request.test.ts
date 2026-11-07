import { hyperlink } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultFooterComponent } from "../extensions/default-footer/src/index.ts";
import {
	countPullRequestChecks,
	formatPullRequest,
	parsePullRequest,
	type PullRequest,
} from "../extensions/default-footer/src/pull-request.ts";
import { PullRequestStatus } from "../extensions/default-footer/src/pull-request-status.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../src/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const PR_URL = "https://github.com/earendil-works/pi/pull/41208";

beforeEach(() => {
	initTheme(undefined, false);
});

function createContext(): ExtensionContext {
	return {
		model: { id: "test-model", provider: "test", contextWindow: 272_000, reasoning: false },
		sessionManager: {
			getCwd: () => "/tmp/project",
			getEntries: () => [],
			getLeafId: () => null,
			getSessionName: () => "",
		},
		getContextUsage: () => ({ contextWindow: 272_000, percent: 12.5 }),
		getThinkingLevel: () => "off",
	} as unknown as ExtensionContext;
}

function createFooterData(branch: string | null): ReadonlyFooterDataProvider {
	return {
		getAvailableProviderCount: () => 1,
		getExecutableName: () => undefined,
		getExtensionStatuses: () => new Map<string, string>(),
		getGitBranch: () => branch,
		getSessionOverride: () => undefined,
		onBranchChange: () => () => {},
	};
}

function pwdLine(branch: string | null, pullRequest: PullRequest | undefined, sessionName = ""): string {
	initTheme(undefined, false);
	const ctx = createContext();
	const context = {
		...ctx,
		sessionManager: { ...ctx.sessionManager, getSessionName: () => sessionName },
	} as unknown as ExtensionContext;
	const footer = createDefaultFooterComponent({
		ctx: context,
		footerData: createFooterData(branch),
		getPullRequest: () => pullRequest,
		theme,
	});
	return footer.render(160)[0] ?? "";
}

const openPullRequest: PullRequest = {
	number: 41208,
	url: PR_URL,
	state: "open",
	checks: { passed: 4, running: 1, failed: 0 },
};

describe("pull request parsing", () => {
	it("accepts a GitHub pull request from gh", () => {
		expect(
			parsePullRequest({
				number: 41208,
				url: PR_URL,
				state: "OPEN",
				statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
			}),
		).toEqual({ number: 41208, url: PR_URL, state: "open", checks: { passed: 1, running: 0, failed: 0 } });
	});

	it("rejects lookalike hosts, mismatched numbers, unknown states, and missing fields", () => {
		expect(parsePullRequest({ number: 1, url: "https://github.com.evil.test/a/b/pull/1", state: "OPEN" })).toBeUndefined();
		expect(parsePullRequest({ number: 2, url: PR_URL, state: "OPEN" })).toBeUndefined();
		expect(parsePullRequest({ number: 41208, url: PR_URL, state: "DRAFT" })).toBeUndefined();
		expect(parsePullRequest({ number: "41208", url: PR_URL, state: "OPEN" })).toBeUndefined();
		expect(parsePullRequest({ number: 41208, state: "OPEN" })).toBeUndefined();
		expect(parsePullRequest("not a pull request")).toBeUndefined();
	});
});

describe("pull request checks", () => {
	it("counts CheckRuns and StatusContexts, keeping unknown states out of passed", () => {
		expect(
			countPullRequestChecks([
				{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
				{ name: "skip", conclusion: "SKIPPED" },
				{ name: "lint", status: "IN_PROGRESS" },
				{ context: "deploy", state: "PENDING" },
				{ context: "CI", state: "ERROR" },
				{ name: "test", conclusion: "TIMED_OUT" },
				{ name: "unknown", status: "COMPLETED" },
				{},
				null,
			]),
		).toEqual({ passed: 2, running: 3, failed: 2 });
		expect(countPullRequestChecks(undefined)).toEqual({ passed: 0, running: 0, failed: 0 });
	});
});

describe("pull request formatting", () => {
	it("links and colors the number and shows only the check states that occur", () => {
		expect(formatPullRequest(openPullRequest, theme)).toBe(
			`${theme.fg("success", hyperlink("#41208", PR_URL))} ${theme.fg("success", "✓ 4")} ${theme.fg("warning", "○ 1")}`,
		);
	});

	it("colors merged and closed states differently from open", () => {
		const merged = formatPullRequest({ ...openPullRequest, state: "merged", checks: { passed: 4, running: 0, failed: 0 } }, theme);
		const closed = formatPullRequest({ ...openPullRequest, state: "closed", checks: { passed: 0, running: 0, failed: 2 } }, theme);

		expect(merged.startsWith(theme.fg("accent", hyperlink("#41208", PR_URL)))).toBe(true);
		expect(merged).not.toContain("○");
		expect(closed.startsWith(theme.fg("error", hyperlink("#41208", PR_URL)))).toBe(true);
		expect(stripAnsi(closed)).toBe("#41208 ✗ 2");
	});
});

describe("pull request footer line", () => {
	it("shows the branch pull request between the branch and the session name", () => {
		const line = pwdLine("main", openPullRequest, "deploy check");

		expect(line).toContain(hyperlink("#41208", PR_URL));
		expect(stripAnsi(line)).toBe("/tmp/project (main) #41208 ✓ 4 ○ 1 • deploy check");
	});

	it("hides the pull request outside a repository and on a detached HEAD", () => {
		expect(stripAnsi(pwdLine(null, openPullRequest))).toBe("/tmp/project");
		expect(stripAnsi(pwdLine("detached", openPullRequest))).toBe("/tmp/project (detached)");
	});
});

describe("pull request polling", () => {
	it("notifies only when the displayed status changes and stops after dispose", async () => {
		const onChange = vi.fn();
		let next: PullRequest | undefined = openPullRequest;
		const status = new PullRequestStatus("/repo", () => "main", onChange, async () => next);

		await status.refresh();
		expect(status.get()).toEqual(openPullRequest);
		expect(onChange).toHaveBeenCalledTimes(1);

		await status.refresh();
		expect(onChange).toHaveBeenCalledTimes(1);

		next = { ...openPullRequest, checks: { passed: 0, running: 0, failed: 2 } };
		await status.refresh();
		expect(onChange).toHaveBeenCalledTimes(2);

		next = undefined;
		await status.refresh();
		expect(status.get()).toBeUndefined();
		expect(onChange).toHaveBeenCalledTimes(3);

		status.dispose();
		next = openPullRequest;
		await status.refresh();
		expect(status.get()).toBeUndefined();
		expect(onChange).toHaveBeenCalledTimes(3);
	});

	it("keeps the displayed pull request when gh fails", async () => {
		const onChange = vi.fn();
		let fail = false;
		const status = new PullRequestStatus("/repo", () => "main", onChange, async () => {
			if (fail) throw new Error("gh: network unreachable");
			return openPullRequest;
		});

		await status.refresh();
		fail = true;
		await status.refresh();

		expect(status.get()).toEqual(openPullRequest);
		expect(onChange).toHaveBeenCalledTimes(1);
		status.dispose();
	});

	it("clears the previous branch's pull request as soon as the branch changes", async () => {
		const onChange = vi.fn();
		let branch = "feature";
		const status = new PullRequestStatus("/repo", () => branch, onChange, async () => openPullRequest);

		await status.refresh();
		branch = "other-feature";
		void status.refresh();

		expect(status.get()).toBeUndefined();
		status.dispose();
	});

	it("reads no pull request outside a repository", async () => {
		const read = vi.fn(async () => openPullRequest);
		const status = new PullRequestStatus("/repo", () => null, vi.fn(), read);

		await status.refresh();

		expect(status.get()).toBeUndefined();
		expect(read).not.toHaveBeenCalled();
		status.dispose();
	});
});
