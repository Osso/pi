const GOAL_STATUS_KEY = "goal";

export function sanitizeFooterStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export function formatExtensionStatusTextLines(statuses: ReadonlyMap<string, string>): string[] {
	const sortedStatuses = Array.from(statuses.entries()).sort(([left], [right]) => left.localeCompare(right));
	const goalStatus = sortedStatuses.find(([key]) => key === GOAL_STATUS_KEY);
	const otherStatusTexts = sortedStatuses
		.filter(([key]) => key !== GOAL_STATUS_KEY)
		.map(([, text]) => sanitizeFooterStatusText(text));
	const otherStatusLine = otherStatusTexts.length > 0 ? otherStatusTexts.join(" ") : undefined;
	const goalStatusLine = goalStatus ? sanitizeFooterStatusText(goalStatus[1]) : undefined;

	return [otherStatusLine, goalStatusLine].filter((line): line is string => line !== undefined);
}
