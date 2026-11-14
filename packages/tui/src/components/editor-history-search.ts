/** The line of a history entry shown in the history search list: the first line matching the query. */
export function historySearchPreviewLine(entry: string, query: string): string {
	const displayableLines = entry.split(/\r?\n/).filter((line) => {
		const trimmed = line.trim();
		return trimmed.length > 0 && trimmed !== "```";
	});
	const lowerQuery = query.toLocaleLowerCase();
	const previewLine =
		displayableLines.find((line) => line.toLocaleLowerCase().includes(lowerQuery)) ?? displayableLines[0] ?? "";
	return previewLine.trimStart();
}

/** Show the first case-insensitive match of the query in reverse video. */
export function highlightHistorySearchMatch(text: string, query: string): string {
	if (query.length === 0) return text;
	const matchIndex = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
	if (matchIndex < 0) return text;
	const matchEnd = matchIndex + query.length;
	return `${text.slice(0, matchIndex)}\x1b[7m${text.slice(matchIndex, matchEnd)}\x1b[27m${text.slice(matchEnd)}`;
}
