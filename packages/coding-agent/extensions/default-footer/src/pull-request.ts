import { hyperlink } from "@earendil-works/pi-tui";
import type { Theme } from "../../../src/modes/interactive/theme/theme.ts";

export type PullRequestState = "open" | "closed" | "merged";

export interface PullRequestChecks {
	passed: number;
	running: number;
	failed: number;
}

/** Output of `github pr branch <branch> --json`. */
export interface PullRequest {
	number: number;
	url: string;
	state: PullRequestState;
	checks: PullRequestChecks;
}

/** Match real GitHub pull URLs only, so a lookalike host cannot produce a link. */
const PULL_REQUEST_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/([1-9]\d*)$/i;
const PULL_REQUEST_STATES: readonly PullRequestState[] = ["open", "closed", "merged"];
function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseChecks(value: unknown): PullRequestChecks | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { passed, running, failed } = value as Record<string, unknown>;
	if (!isCount(passed) || !isCount(running) || !isCount(failed)) return undefined;
	return { passed, running, failed };
}

export function parsePullRequest(value: unknown): PullRequest | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.url !== "string" || typeof raw.number !== "number" || !Number.isSafeInteger(raw.number)) {
		return undefined;
	}
	if (!PULL_REQUEST_STATES.includes(raw.state as PullRequestState)) return undefined;
	const match = PULL_REQUEST_URL.exec(raw.url);
	// The URL is the link target, so it must describe the same pull request.
	if (!match || Number(match[1]) !== raw.number) return undefined;
	const checks = parseChecks(raw.checks);
	if (!checks) return undefined;
	return { number: raw.number, url: raw.url, state: raw.state as PullRequestState, checks };
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
