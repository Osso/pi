/** Validate the optional percentage used to trigger automatic compaction. */
export function parseCompactionThresholdPercent(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	const isNumber = typeof value === "number";
	const isFinitePercentage = isNumber && Number.isFinite(value);
	const isValidRange = isNumber && value > 0 && value <= 100;
	if (!isFinitePercentage || !isValidRange) {
		throw new Error(
			`Invalid compaction.thresholdPercent setting: ${String(value)}. Use a finite number greater than 0 and at most 100, or remove the setting.`,
		);
	}
	return value;
}
