import { hyperlink } from "@earendil-works/pi-tui";
import type { Theme } from "../../../src/modes/interactive/theme/theme.ts";

export type PullRequestState = "open" | "closed" | "merged";

export interface PullRequestChecks {
	passed: number;
	running: number;
	failed: number;
}

/** Pull request fields taken from `gh pr view --json number,url,state,statusCheckRollup`. */
export interface PullRequest {
	number: number;
	url: string;
	state: PullRequestState;
	checks: PullRequestChecks;
}

/** Match real GitHub pull URLs only, so a lookalike host cannot produce a link. */
const PULL_REQUEST_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/([1-9]\d*)$/i;
const PULL_REQUEST_STATES: readonly PullRequestState[] = ["open", "closed", "merged"];
/** GitHub mixes CheckRuns (status/conclusion) and StatusContexts (state) in one rollup. */
const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED", "EXPECTED"]);
const FAILING_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"]);

function checkOutcome(item: unknown): keyof PullRequestChecks | undefined {
	if (!item || typeof item !== "object") return undefined;
	const check = item as Record<string, unknown>;
	const conclusion = String(check.conclusion ?? "").toUpperCase();
	const status = String(check.status ?? check.state ?? "").toUpperCase();
	if (!conclusion && !status) return undefined;
	if (FAILING_CONCLUSIONS.has(conclusion) || status === "FAILURE" || status === "ERROR") return "failed";
	if (PASSING_CONCLUSIONS.has(conclusion) || status === "SUCCESS" || status === "EXPECTED") return "passed";
	// Queued, in-progress, and unknown states must never look green.
	return "running";
}

export function countPullRequestChecks(statusCheckRollup: unknown): PullRequestChecks {
	const checks: PullRequestChecks = { passed: 0, running: 0, failed: 0 };
	if (!Array.isArray(statusCheckRollup)) return checks;
	for (const item of statusCheckRollup) {
		const outcome = checkOutcome(item);
		if (outcome) checks[outcome] += 1;
	}
	return checks;
}

export function parsePullRequest(value: unknown): PullRequest | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const state = String(raw.state ?? "").toLowerCase();
	if (typeof raw.url !== "string" || typeof raw.number !== "number" || !Number.isSafeInteger(raw.number)) {
		return undefined;
	}
	if (!PULL_REQUEST_STATES.includes(state as PullRequestState)) return undefined;
	const match = PULL_REQUEST_URL.exec(raw.url);
	// The URL is the link target, so it must describe the same pull request.
	if (!match || Number(match[1]) !== raw.number) return undefined;
	return {
		number: raw.number,
		url: raw.url,
		state: state as PullRequestState,
		checks: countPullRequestChecks(raw.statusCheckRollup),
	};
}

interface CheckSegment {
	outcome: keyof PullRequestChecks;
	glyph: string;
	color: "success" | "warning" | "error";
}

const CHECK_SEGMENTS: readonly CheckSegment[] = [
	{ outcome: "passed", glyph: "✓", color: "success" },
	{ outcome: "running", glyph: "○", color: "warning" },
	{ outcome: "failed", glyph: "✗", color: "error" },
];

function stateColor(state: PullRequestState): "success" | "accent" | "error" {
	if (state === "open") return "success";
	return state === "merged" ? "accent" : "error";
}

/** `#123 ✓ 4 ✗ 1`: linked and state-colored number, then only the check states that occur. */
export function formatPullRequest(pullRequest: PullRequest, theme: Theme): string {
	const number = theme.fg(stateColor(pullRequest.state), hyperlink(`#${pullRequest.number}`, pullRequest.url));
	const presentChecks = CHECK_SEGMENTS.filter((segment) => pullRequest.checks[segment.outcome] > 0);
	const checks = presentChecks.map((segment) =>
		theme.fg(segment.color, `${segment.glyph} ${pullRequest.checks[segment.outcome]}`),
	);
	return [number, ...checks].join(" ");
}
