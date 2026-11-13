import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

function toolResultText(message: { content: unknown }): string {
	return (message.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("");
}

/** The model must see the file from line 1, and the read notice must describe exactly the lines it received. */
function expectIntactReadResult(text: string, lineText: (lineNumber: number) => string): void {
	expect(text).not.toContain("[tool output truncated");
	const notice = text.match(/\n\n\[Showing lines 1-(\d+) .*Use offset=(\d+) to continue\.\]$/);
	expect(notice, text.slice(-200)).not.toBeNull();
	const lastLine = Number(notice?.[1]);
	expect(Number(notice?.[2])).toBe(lastLine + 1);
	const lines = text.slice(0, text.length - (notice?.[0].length ?? 0)).split("\n");
	expect(lines).toHaveLength(lastLine);
	expect(lines[0]).toBe(lineText(1));
	expect(lines.at(-1)).toBe(lineText(lastLine));
}

it("delivers large-file reads to the model from the first line with a matching continuation notice", async () => {
	await withHeadlessPi(async (agent) => {
		const shortLines = join(agent.paths.workspaceDir, "short-lines.txt");
		const shortLineText = (lineNumber: number) => `L${lineNumber}`;
		writeFileSync(shortLines, Array.from({ length: 3000 }, (_, index) => shortLineText(index + 1)).join("\n"));
		const wideLines = join(agent.paths.workspaceDir, "wide-lines.txt");
		const wideLineText = (lineNumber: number) => `row ${lineNumber} ${"x".repeat(40)}`;
		writeFileSync(wideLines, Array.from({ length: 500 }, (_, index) => wideLineText(index + 1)).join("\n"));
		// 1024 lines of 9 characters are 10,239 bytes: under the read limit, but not with the continuation notice.
		const limitedLines = join(agent.paths.workspaceDir, "limited-lines.txt");
		const limitedLineText = (lineNumber: number) => `l${String(lineNumber).padStart(8, "0")}`;
		writeFileSync(limitedLines, Array.from({ length: 1500 }, (_, index) => limitedLineText(index + 1)).join("\n"));

		await agent.send({ type: "prompt", message: "Read the files" });
		const first = await agent.waitForLlmRequest();
		agent.respondToLlmRequest(
			first.id,
			fauxAssistantMessage(
				[
					fauxToolCall("read", { path: shortLines }),
					fauxToolCall("read", { path: wideLines }),
					fauxToolCall("read", { path: limitedLines, limit: 1024 }),
				],
				{ stopReason: "toolUse" },
			),
		);
		const afterTools = await agent.waitForLlmRequest();
		const [shortResult, wideResult, limitedResult] = afterTools.messages.filter(
			(message) => message.role === "toolResult",
		);
		if (!shortResult || !wideResult || !limitedResult) throw new Error("Missing read tool results");

		expectIntactReadResult(toolResultText(shortResult), shortLineText);
		expectIntactReadResult(toolResultText(wideResult), wideLineText);
		const expectedLimited = Array.from({ length: 1024 }, (_, index) => limitedLineText(index + 1)).join("\n");
		expect(toolResultText(limitedResult)).toBe(
			`${expectedLimited}\n\n[476 more lines in file. Use offset=1025 to continue.]`,
		);
		agent.respondToLlmRequest(afterTools.id, fauxAssistantMessage("Read the files"));
	});
}, 60_000);
