export interface DetachedArtifactRetentionCandidate {
	directoryPath: string;
	byteSize: number;
	terminalAt: number;
	protectedByLiveReference: boolean;
}

export interface DetachedArtifactRetentionPolicy {
	now: number;
	maxAge: number;
	maxBytes: number;
}

function requireNonnegativeFinite(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`${name} must be a nonnegative finite number`);
	}
}

function compareCandidates(
	left: DetachedArtifactRetentionCandidate,
	right: DetachedArtifactRetentionCandidate,
): number {
	return left.terminalAt - right.terminalAt || left.directoryPath.localeCompare(right.directoryPath);
}

export function selectDetachedArtifactDirectoriesToDelete(
	candidates: readonly DetachedArtifactRetentionCandidate[],
	policy: DetachedArtifactRetentionPolicy,
): string[] {
	validateRetentionInput(candidates, policy);
	const orderedCandidates = [...candidates].sort(compareCandidates);
	const expiredCandidates = findExpiredCandidates(orderedCandidates, policy);
	return selectExpiredAndOverCapCandidates(orderedCandidates, expiredCandidates, policy.maxBytes);
}

function validateRetentionInput(
	candidates: readonly DetachedArtifactRetentionCandidate[],
	policy: DetachedArtifactRetentionPolicy,
): void {
	requireNonnegativeFinite(policy.now, "Retention policy now");
	requireNonnegativeFinite(policy.maxAge, "Retention policy maximum age");
	requireNonnegativeFinite(policy.maxBytes, "Retention policy maximum bytes");
	for (const candidate of candidates) {
		requireNonnegativeFinite(candidate.byteSize, `Artifact ${candidate.directoryPath} byte size`);
		requireNonnegativeFinite(candidate.terminalAt, `Artifact ${candidate.directoryPath} terminal timestamp`);
	}
}

function findExpiredCandidates(
	candidates: readonly DetachedArtifactRetentionCandidate[],
	policy: DetachedArtifactRetentionPolicy,
): DetachedArtifactRetentionCandidate[] {
	const oldestRetainedTimestamp = policy.now - policy.maxAge;
	return candidates.filter(
		(candidate) => !candidate.protectedByLiveReference && candidate.terminalAt <= oldestRetainedTimestamp,
	);
}

function selectExpiredAndOverCapCandidates(
	orderedCandidates: readonly DetachedArtifactRetentionCandidate[],
	expiredCandidates: readonly DetachedArtifactRetentionCandidate[],
	maxBytes: number,
): string[] {
	const expiredPaths = new Set(expiredCandidates.map((candidate) => candidate.directoryPath));
	const expiredBytes = expiredCandidates.reduce((total, candidate) => total + candidate.byteSize, 0);
	let retainedBytes = orderedCandidates.reduce((total, candidate) => total + candidate.byteSize, 0) - expiredBytes;
	const pathsToDelete = expiredCandidates.map((candidate) => candidate.directoryPath);
	for (const candidate of orderedCandidates) {
		if (retainedBytes <= maxBytes) break;
		if (candidate.protectedByLiveReference || expiredPaths.has(candidate.directoryPath)) continue;
		pathsToDelete.push(candidate.directoryPath);
		retainedBytes -= candidate.byteSize;
	}
	return pathsToDelete;
}
