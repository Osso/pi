import { isAbsolute, relative, resolve, sep } from "node:path";

const GOAL_STATUS_KEY = "goal";
const MISSION_STATUS_KEY = "mission";

export function formatFooterTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export function sanitizeFooterStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export function formatExtensionStatusTextLines(statuses: ReadonlyMap<string, string>): string[] {
	const sortedStatuses = Array.from(statuses.entries()).sort(([left], [right]) => left.localeCompare(right));
	const missionStatus = sortedStatuses.find(([key]) => key === MISSION_STATUS_KEY);
	const goalStatus = sortedStatuses.find(([key]) => key === GOAL_STATUS_KEY);
	const otherStatusTexts = sortedStatuses
		.filter(([key]) => key !== MISSION_STATUS_KEY && key !== GOAL_STATUS_KEY)
		.map(([, text]) => sanitizeFooterStatusText(text));
	const otherStatusLine = otherStatusTexts.length > 0 ? otherStatusTexts.join(" ") : undefined;
	const missionStatusLine = missionStatus ? sanitizeFooterStatusText(missionStatus[1]) : undefined;
	const goalStatusLine = goalStatus ? sanitizeFooterStatusText(goalStatus[1]) : undefined;

	return [otherStatusLine, missionStatusLine, goalStatusLine].filter((line): line is string => line !== undefined);
}
