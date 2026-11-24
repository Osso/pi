const CLAUSE_SEPARATOR = "; ";

function isWholeClauseAt(text: string, index: number, length: number): boolean {
	const startsClause = index === 0 || text.startsWith(CLAUSE_SEPARATOR, index - CLAUSE_SEPARATOR.length);
	const end = index + length;
	return startsClause && (end === text.length || text.startsWith(";", end));
}

export function deduplicateCurrentGoalScope(reviewedObjective: string, currentObjective: string): string {
	let deduplicated = reviewedObjective;
	let keptFirstCopy = false;
	let index = deduplicated.indexOf(currentObjective);
	while (index !== -1) {
		if (!isWholeClauseAt(deduplicated, index, currentObjective.length)) {
			index = deduplicated.indexOf(currentObjective, index + 1);
		} else if (!keptFirstCopy) {
			keptFirstCopy = true;
			index = deduplicated.indexOf(currentObjective, index + currentObjective.length);
		} else {
			const removalStart = index - CLAUSE_SEPARATOR.length;
			deduplicated = `${deduplicated.slice(0, removalStart)}${deduplicated.slice(index + currentObjective.length)}`;
			index = deduplicated.indexOf(currentObjective, removalStart);
		}
	}
	return deduplicated.trim();
}
