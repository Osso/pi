import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import { FooterDataProvider } from "../../../src/core/footer-data-provider.ts";
import type { PullRequest } from "./pull-request.ts";
import { PullRequestStatus } from "./pull-request-status.ts";

/** Status key RPC clients (pi-desktop) read the branch's pull request from. */
export const PULL_REQUEST_STATUS_KEY = "pull-request";

/** `<url> <state> ✓ <passed> ○ <running> ✗ <failed>`: plain text, so a client can link it. */
export function formatPullRequestStatus(pullRequest: PullRequest): string {
	const { passed, running, failed } = pullRequest.checks;
	return `${pullRequest.url} ${pullRequest.state} ✓ ${passed} ○ ${running} ✗ ${failed}`;
}

/** Outside a repository, or on a detached HEAD, no branch can have a pull request. */
export function branchCanHavePullRequest(branch: string | null): branch is string {
	return branch !== null && branch !== "detached";
}

/**
 * RPC mode has no TUI footer: publish the current branch's pull request as the
 * `pull-request` status instead. Returns the stop function.
 */
export function startPullRequestRpcStatus(ctx: ExtensionContext): () => void {
	const footerData = new FooterDataProvider(ctx.cwd);
	const branch = (): string | null => {
		const current = footerData.getGitBranch();
		return branchCanHavePullRequest(current) ? current : null;
	};
	const status: PullRequestStatus = new PullRequestStatus(ctx.cwd, branch, () => {
		const pullRequest = status.get();
		ctx.ui.setStatus(PULL_REQUEST_STATUS_KEY, pullRequest ? formatPullRequestStatus(pullRequest) : undefined);
	});
	const unsubscribe = footerData.onBranchChange(() => void status.refresh());
	status.start();
	return () => {
		status.dispose();
		unsubscribe();
		footerData.dispose();
	};
}
