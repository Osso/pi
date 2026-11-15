import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type PullRequest, parsePullRequest } from "./pull-request.ts";

const runFile = promisify(execFile);
const GITHUB_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
/** A pull request can appear for the current branch without a branch change, so poll both cases alike. */
const REFRESH_INTERVAL_MS = 5 * 60_000;

export type PullRequestReader = (branch: string, cwd: string) => Promise<PullRequest | undefined>;

/**
 * `github pr branch` looks in the repository the branch is pushed to and prints `null` when it has no
 * pull request, so errors stay distinguishable.
 */
async function readPullRequestFromGitHub(branch: string, cwd: string): Promise<PullRequest | undefined> {
	const { stdout } = await runFile("github", ["pr", "branch", branch, "--json"], {
		cwd,
		timeout: GITHUB_TIMEOUT_MS,
		maxBuffer: MAX_OUTPUT_BYTES,
	});
	return parsePullRequest(JSON.parse(stdout));
}

/** A failed read keeps the last displayed status instead of hiding a real pull request. */
async function readPullRequest(
	read: PullRequestReader,
	branch: string,
	cwd: string,
): Promise<{ pullRequest: PullRequest | undefined; failed: boolean }> {
	try {
		return { pullRequest: await read(branch, cwd), failed: false };
	} catch {
		return { pullRequest: undefined, failed: true };
	}
}

function samePullRequest(left: PullRequest | undefined, right: PullRequest | undefined): boolean {
	if (!left || !right) return left === right;
	return (
		left.number === right.number &&
		left.url === right.url &&
		left.state === right.state &&
		left.checks.passed === right.checks.passed &&
		left.checks.running === right.checks.running &&
		left.checks.failed === right.checks.failed
	);
}

/** Polls the current branch's pull request and notifies when the displayed status changes. */
export class PullRequestStatus {
	private readonly cwd: string;
	private readonly getBranch: () => string | null;
	private readonly onChange: () => void;
	private readonly read: PullRequestReader;
	private pullRequest: PullRequest | undefined;
	private branch: string | null | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private reading = false;
	private disposed = false;

	constructor(
		cwd: string,
		getBranch: () => string | null,
		onChange: () => void,
		read: PullRequestReader = readPullRequestFromGitHub,
	) {
		this.cwd = cwd;
		this.getBranch = getBranch;
		this.onChange = onChange;
		this.read = read;
	}

	/** Current pull request; undefined until the first read completes or when the branch has none. */
	get(): PullRequest | undefined {
		return this.pullRequest;
	}

	start(): void {
		void this.refresh();
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	async refresh(): Promise<void> {
		const branch = this.getBranch();
		this.forgetOtherBranch(branch);
		if (this.reading || this.disposed) return;
		if (!branch) {
			this.schedule(REFRESH_INTERVAL_MS);
			return;
		}

		this.reading = true;
		const result = await readPullRequest(this.read, branch, this.cwd);
		this.reading = false;
		if (this.disposed) return;
		// The branch changed during the read: drop the stale result and read the current branch now.
		if (this.branch !== branch) return this.refresh();
		if (!result.failed) this.publish(result.pullRequest);
		this.schedule(REFRESH_INTERVAL_MS);
	}

	/** A pull request read for another branch must not stay on screen while the new branch is read. */
	private forgetOtherBranch(branch: string | null): void {
		if (this.branch === branch) return;
		this.branch = branch;
		this.publish(undefined);
	}

	private publish(pullRequest: PullRequest | undefined): void {
		const changed = !samePullRequest(pullRequest, this.pullRequest);
		this.pullRequest = pullRequest;
		if (changed) this.onChange();
	}

	private schedule(intervalMs: number): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.refresh(), intervalMs);
		this.timer.unref?.();
	}
}
