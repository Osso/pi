export function splitKeyId(keyId: string): string[] {
	const normalized = keyId.toLowerCase();
	if (normalized === "+") return ["+"];
	if (normalized.endsWith("++")) return [...normalized.slice(0, -2).split("+"), "+"];
	return normalized.split("+");
}

const MODIFIER_ORDER = ["ctrl", "shift", "alt", "super"];
const KEY_ALIASES: Record<string, string> = { esc: "escape", return: "enter" };

/** One spelling per key: lower case, modifiers in a fixed order, aliases resolved ("shift+ctrl+x" -> "ctrl+shift+x"). */
export function canonicalKeyId(keyId: string): string {
	const parts = splitKeyId(keyId);
	const key = parts.pop() ?? "";
	const modifiers = MODIFIER_ORDER.filter((modifier) => parts.includes(modifier));
	return [...modifiers, KEY_ALIASES[key] ?? key].join("+");
}
