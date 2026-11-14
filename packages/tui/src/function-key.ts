import type { KeyEventType } from "./keys.ts";

export const FUNCTION_KEY_CODEPOINTS = {
	f1: 57364,
	f2: 57365,
	f3: 57366,
	f4: 57367,
	f5: 57368,
	f6: 57369,
	f7: 57370,
	f8: 57371,
	f9: 57372,
	f10: 57373,
	f11: 57374,
	f12: 57375,
} as const;

const FUNCTION_KEY_TILDE_CODES = [11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24];

export function parseFunctionKeySequence(
	data: string,
): { codepoint: number; modifier: number; eventType: KeyEventType } | null {
	// CSI [1;modifier[:event]] P/Q/R/S, or CSI number[;modifier[:event]] ~.
	const match = data.match(/^\x1b\[(?:(?:1;(\d+)(?::(\d+))?)?([PQRS])|(\d+)(?:;(\d+)(?::(\d+))?)?~)$/);
	if (!match) return null;
	const index = match[3] ? "PQRS".indexOf(match[3]) : FUNCTION_KEY_TILDE_CODES.indexOf(Number(match[4]));
	if (index < 0) return null;
	const event = match[2] ?? match[6];
	return {
		codepoint: FUNCTION_KEY_CODEPOINTS.f1 + index,
		modifier: Number(match[1] ?? match[5] ?? 1) - 1,
		eventType: event === "2" ? "repeat" : event === "3" ? "release" : "press",
	};
}

export function formatFunctionKeyName(codepoint: number): string | undefined {
	if (codepoint < FUNCTION_KEY_CODEPOINTS.f1 || codepoint > FUNCTION_KEY_CODEPOINTS.f12) return undefined;
	return `f${codepoint - FUNCTION_KEY_CODEPOINTS.f1 + 1}`;
}
