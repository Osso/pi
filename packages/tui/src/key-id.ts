export function splitKeyId(keyId: string): string[] {
	const normalized = keyId.toLowerCase();
	if (normalized === "+") return ["+"];
	if (normalized.endsWith("++")) return [...normalized.slice(0, -2).split("+"), "+"];
	return normalized.split("+");
}
