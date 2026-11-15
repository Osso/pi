import type { UserBashEventResult } from "./types.ts";

/** True when a user_bash handler returned exactly one valid `{ operations }` or `{ result }` object. */
export function isUserBashEventResult(value: unknown): value is UserBashEventResult {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	const hasOperations = candidate.operations !== undefined;
	const hasResult = candidate.result !== undefined;
	if (hasOperations === hasResult) return false;

	if (hasOperations) {
		const operations = candidate.operations;
		if (typeof operations !== "object" || operations === null) return false;
		return typeof (operations as Record<string, unknown>).exec === "function";
	}

	const result = candidate.result;
	if (typeof result !== "object" || result === null) return false;
	const resultRecord = result as Record<string, unknown>;
	return (
		typeof resultRecord.output === "string" &&
		"exitCode" in resultRecord &&
		(resultRecord.exitCode === undefined || typeof resultRecord.exitCode === "number") &&
		typeof resultRecord.cancelled === "boolean" &&
		typeof resultRecord.truncated === "boolean" &&
		(resultRecord.fullOutputPath === undefined || typeof resultRecord.fullOutputPath === "string")
	);
}
