/** Validate the optional percentage used to trigger automatic compaction. */
export function parseCompactionThresholdPercent(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100) {
		throw new Error(
			`Invalid compaction.thresholdPercent setting: ${String(value)}. Use a finite number greater than 0 and at most 100, or remove the setting.`,
		);
	}
	return value;
}
