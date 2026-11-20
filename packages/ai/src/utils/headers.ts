import type { ProviderHeaders } from "../types.ts";

export function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

/**
 * Merge header sources in order. Later sources override earlier ones by
 * case-insensitive name, and a null value removes an earlier header.
 */
export function providerHeadersToRecord(
	...sources: Array<ProviderHeaders | undefined>
): Record<string, string> | undefined {
	const result: Record<string, string> = {};
	for (const headers of sources) {
		for (const [key, value] of Object.entries(headers ?? {})) {
			const lowerKey = key.toLowerCase();
			for (const existing of Object.keys(result)) {
				if (existing.toLowerCase() === lowerKey) delete result[existing];
			}
			if (value !== null) result[key] = value;
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}
