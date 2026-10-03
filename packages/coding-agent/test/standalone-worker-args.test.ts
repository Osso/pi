import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";

describe("standalone worker arguments", () => {
	it("parses explicit opt-out without changing ordinary no-session", () => {
		expect(parseArgs(["--no-supervisor", "--no-session", "--print", "work"])).toMatchObject({
			noSupervisor: true,
			noSession: true,
			messages: ["work"],
			diagnostics: [],
		});
		expect(parseArgs(["--no-session"]).noSupervisor).toBeUndefined();
	});
	it("requires an ephemeral session", () => {
		expect(parseArgs(["--no-supervisor"]).diagnostics).toContainEqual({
			type: "error",
			message: "--no-supervisor requires --no-session",
		});
	});
	it.each(["--session", "--session-id", "--session-dir", "--fork", "--resume", "--continue", "--name", "--export"])(
		"rejects %s before session lookup",
		(flag) => {
			const result = parseArgs(["--no-supervisor", "--no-session", flag, "target"]);
			expect(result.diagnostics.some((d) => d.type === "error" && d.message.includes(flag))).toBe(true);
		},
	);
});
