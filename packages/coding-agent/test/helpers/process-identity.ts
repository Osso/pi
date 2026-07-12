import { readProcessIdentity } from "../../src/core/runtime-process.ts";

export const CURRENT_PROCESS_IDENTITY = readProcessIdentity(process.pid);

export function testProcessIdentity(name: string): { pid: number; startTimeTicks: number } {
	let value = 0;
	for (const character of name) value = (value * 31 + character.charCodeAt(0)) >>> 0;
	return { pid: 1_000_000_000 + (value % 1_000_000_000), startTimeTicks: value + 1 };
}
