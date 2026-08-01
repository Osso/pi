export function deduplicateCurrentGoalScope(reviewedObjective: string, currentObjective: string): string {
	const firstScopeIndex = reviewedObjective.indexOf(currentObjective);
	if (firstScopeIndex === -1) return reviewedObjective;

	let deduplicated = reviewedObjective;
	let nextScopeIndex = deduplicated.indexOf(currentObjective, firstScopeIndex + currentObjective.length);
	while (nextScopeIndex !== -1) {
		const separatorStart = deduplicated.lastIndexOf("; ", nextScopeIndex);
		const removalStart = separatorStart + 2 === nextScopeIndex ? separatorStart : nextScopeIndex;
		deduplicated = `${deduplicated.slice(0, removalStart)}${deduplicated.slice(nextScopeIndex + currentObjective.length)}`;
		nextScopeIndex = deduplicated.indexOf(currentObjective, firstScopeIndex + currentObjective.length);
	}
	return deduplicated.trim();
}
