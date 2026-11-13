import { describe, expect, test } from "vitest";
import type { Args } from "../src/cli/args.ts";
import { buildInitialMessage } from "../src/cli/initial-message.ts";

function createArgs(messages: string[] = []): Args {
	return {
		messages: [...messages],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};
}

describe("buildInitialMessage", () => {
	test("merges piped stdin with the first CLI message into one prompt", () => {
		const parsed = createArgs(["Summarize the text given"]);
		const result = buildInitialMessage({
			parsed,
			stdinContent: "README contents\n",
		});

		expect(result.initialMessage).toBe("README contents\nSummarize the text given");
		expect(parsed.messages).toEqual([]);
	});

	test("separates trimmed stdin from the CLI message", () => {
		const parsed = createArgs(["explain"]);
		const result = buildInitialMessage({ parsed, stdinContent: "fix this error" });

		expect(result.initialMessage).toBe("fix this error\nexplain");
	});

	test("sends a lone CLI message unchanged", () => {
		const result = buildInitialMessage({ parsed: createArgs(["hello\n\n"]) });

		expect(result.initialMessage).toBe("hello\n\n");
	});

	test("uses stdin as the initial prompt when no CLI message is present", () => {
		const parsed = createArgs();
		const result = buildInitialMessage({
			parsed,
			stdinContent: "README contents",
		});

		expect(result.initialMessage).toBe("README contents");
		expect(parsed.messages).toEqual([]);
	});

	test("combines stdin, file text, and first CLI message in one prompt", () => {
		const parsed = createArgs(["Explain it", "Second message"]);
		const result = buildInitialMessage({
			parsed,
			stdinContent: "stdin\n",
			fileText: "file\n",
		});

		expect(result.initialMessage).toBe("stdin\nfile\nExplain it");
		expect(parsed.messages).toEqual(["Second message"]);
	});
});
