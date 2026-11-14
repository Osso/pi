import { describe, expect, it } from "vitest";
import { formatCanonicalPyrunEvalResult } from "../extensions/pyrun/src/eval-tool.ts";

function toolText(value: unknown): string {
	const code = "cli.git('status').capture().run()";
	const result = formatCanonicalPyrunEvalResult({ code }, { type: "completed", executed: code, value });
	const [content] = result.content;
	return content?.type === "text" ? content.text : "";
}

describe("Pyrun captured command results", () => {
	it("shows the captured output of a successful command", () => {
		expect(toolText({ stdout: "On branch master\n", stderr: "", exit_code: 0, upstream_results: [] })).toBe(
			"cli.git('status').capture().run()\n\nOn branch master",
		);
	});

	it("shows captured output and the exit code of a failed command", () => {
		expect(
			toolText({ stdout: "", stderr: "fatal: not a git repository\n", exit_code: 128, upstream_results: [] }),
		).toBe("cli.git('status').capture().run()\n\nfatal: not a git repository\nexit code 128");
	});
});
