export type ParsedGoalArgs =
	| { action: "view" | "pause" | "resume" | "clear" }
	| { action: "set"; objective: string };

function unsupportedGoalFlag(parts: string[]): string | undefined {
	const flag = parts.find((part) => part.startsWith("--"));
	if (!flag) return undefined;
	if (flag === "--token-budget" || flag.startsWith("--token-budget=")) {
		return "/goal --token-budget is no longer supported";
	}
	if (flag === "--wall-clock-minutes" || flag.startsWith("--wall-clock-minutes=")) {
		return "/goal --wall-clock-minutes is no longer supported";
	}
	return "Goal flags are no longer supported";
}

function isStandaloneControlAction(action: string, objectiveParts: string[]): action is "pause" | "resume" | "clear" {
	const isControlAction = action === "pause" || action === "resume" || action === "clear";
	return isControlAction && objectiveParts.length === 0;
}

export function parseGoalArgs(args: string): ParsedGoalArgs | { error: string } {
	const parts = args.trim().split(/\s+/).filter((part) => part.length > 0);
	const flagError = unsupportedGoalFlag(parts);
	if (flagError) return { error: flagError };
	if (parts.length === 0) return { action: "view" };
	const [action, ...objectiveParts] = parts;
	if (action === "set") {
		const objective = objectiveParts.join(" ");
		return objective ? { action: "set", objective } : { error: "Use /goal set <objective> to set a goal" };
	}
	if (isStandaloneControlAction(action, objectiveParts)) return { action };
	return { error: "Use /goal set <objective> to set a goal" };
}
