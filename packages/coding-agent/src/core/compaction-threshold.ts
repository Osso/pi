function parseTokenCountSetting(name: string, value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(
			`Invalid compaction.${name} setting: ${String(value)}. Use a positive integer, or remove the setting.`,
		);
	}
	return value;
}

/** Validate the optional absolute context token count that triggers automatic compaction. */
export function parseCompactionThresholdTokens(value: unknown): number | undefined {
	return parseTokenCountSetting("thresholdTokens", value);
}

/** Validate the optional absolute token count that starts speculative background compaction. */
export function parseBackgroundCompactionStartTokens(value: unknown): number | undefined {
	return parseTokenCountSetting("backgroundStartTokens", value);
}
