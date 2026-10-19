import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import xterm from "@xterm/headless";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as terminalExport from "../../../src/core/export-terminal.ts";
import { type FileEntry, SessionManager } from "../../../src/core/session-manager.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

function assistant(text: string, toolId?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...(toolId
				? [{ type: "toolCall" as const, id: toolId, name: "bash", arguments: { command: `echo ${toolId}` } }]
				: []),
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "never-called",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: toolId ? "toolUse" : "stop",
		timestamp: 0,
	};
}

function save(path: string, session: SessionManager): void {
	writeFileSync(path, `${[session.getHeader(), ...session.getEntries()].map((e) => JSON.stringify(e)).join("\n")}\n`);
}

async function terminalText(output: string, columns = 80): Promise<string> {
	const terminal = new xterm.Terminal({
		cols: columns,
		rows: 24,
		scrollback: 10000,
		allowProposedApi: true,
		convertEol: true,
	});
	try {
		await new Promise<void>((resolve) => terminal.write(output, resolve));
		expect(terminal.buffer.active).toBe(terminal.buffer.normal);
		return Array.from(
			{ length: terminal.buffer.normal.length },
			(_, i) => terminal.buffer.normal.getLine(i)?.translateToString(true) ?? "",
		).join("\n");
	} finally {
		terminal.dispose();
	}
}

describe("saved terminal history export", () => {
	let dir: string;
	let path: string;
	beforeEach(() => {
		initTheme("dark", false);
		dir = mkdtempSync(join(tmpdir(), "pi-terminal-export-"));
		path = join(dir, "history.jsonl");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps all numbered exchanges before and after compaction in native scrollback, excluding siblings", async () => {
		const session = SessionManager.inMemory(dir);
		let kept = "";
		for (let i = 1; i <= 100; i++) {
			const id = session.appendMessage({
				role: "user",
				content: `USER-${i.toString().padStart(3, "0")}`,
				timestamp: 0,
			});
			if (i === 90) kept = id;
			session.appendMessage(assistant(`ASSISTANT-${i.toString().padStart(3, "0")}`, `TOOL-${i}`));
			session.appendMessage({
				role: "toolResult",
				toolCallId: `TOOL-${i}`,
				toolName: "bash",
				content: [{ type: "text", text: `RESULT-${i}` }],
				isError: false,
				timestamp: 0,
			});
		}
		const branchPoint = session.getLeafId()!;
		session.appendMessage({ role: "user", content: "ABANDONED-SIBLING", timestamp: 0 });
		session.branch(branchPoint);
		session.appendCompaction("saved summary", kept, 50000);
		session.appendCustomMessageEntry("hidden", "HIDDEN-METADATA", false);
		session.appendCustomEntry("state", { secret: "HIDDEN-STATE" });
		session.appendCustomMessageEntry("notice", "VISIBLE-NOTICE", true);
		session.appendMessage(assistant("AFTER-COMPACTION-END"));
		save(path, session);
		const before = readFileSync(path);
		const mtime = statSync(path).mtimeMs;
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
			throw new Error("provider/network invocation forbidden");
		});
		const output = terminalExport.exportSessionToTerminal(path, 80);
		const text = await terminalText(output);
		for (let i = 1; i <= 100; i++) {
			expect(text).toContain(`USER-${i.toString().padStart(3, "0")}`);
			expect(text).toContain(`ASSISTANT-${i.toString().padStart(3, "0")}`);
			expect(text).toContain(`RESULT-${i}`);
		}
		expect(text).toContain("AFTER-COMPACTION-END");
		expect(text).toContain("VISIBLE-NOTICE");
		expect(text).toContain("Compacted from");
		expect(text).not.toMatch(/ABANDONED-SIBLING|HIDDEN-METADATA|HIDDEN-STATE/);
		expect(output.endsWith("\n")).toBe(true);
		expect(readFileSync(path)).toEqual(before);
		expect(statSync(path).mtimeMs).toBe(mtime);
		expect(readdirSync(dir)).toEqual(["history.jsonl"]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("renders collapsed tools without executing commands or emitting images or unsafe terminal controls", async () => {
		const session = SessionManager.inMemory(dir);
		const attack = "SAFE-BEFORE\x1b[2J\x1b[3J\x1b[H\x1b]52;c;ZXZpbA==\x07\x9b2J\rSAFE-AFTER";
		session.appendMessage({ role: "user", content: attack, timestamp: 0 });
		session.appendMessage(assistant(attack, "unsafe-tool"));
		session.appendMessage({
			role: "toolResult",
			toolCallId: "unsafe-tool",
			toolName: "bash",
			content: [
				{ type: "text", text: Array.from({ length: 200 }, (_, i) => `COLLAPSED-${i}`).join("\n") + attack },
				{ type: "image", data: "not-an-image", mimeType: "image/png" },
			],
			isError: false,
			timestamp: 0,
		});
		save(path, session);
		const output = terminalExport.exportSessionToTerminal(path, 50);
		// Only SGR style sequences may survive; generated shell integration OSCs are omitted too.
		expect(output.replace(/\x1b\[[0-9;:]*m/g, "")).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
		const text = await terminalText(output, 50);
		expect(text).toContain("SAFE-BEFORE");
		expect(text).toContain("SAFE-AFTER");
		expect(text).not.toContain("COLLAPSED-100");
		expect(stripAnsi(output)).toMatch(/more lines|expand/);
	});

	it("migrates legacy history only in memory", () => {
		const entries = [
			{ type: "session", id: "legacy", cwd: dir, timestamp: new Date(0).toISOString() },
			{ type: "message", message: { role: "user", content: "LEGACY-FIRST", timestamp: 0 } },
			{ type: "message", message: assistant("LEGACY-LAST") },
		];
		writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
		const before = readFileSync(path);
		expect(stripAnsi(terminalExport.exportSessionToTerminal(path, 80))).toContain("LEGACY-FIRST");
		expect(stripAnsi(terminalExport.exportSessionToTerminal(path, 80))).toContain("LEGACY-LAST");
		expect(readFileSync(path)).toEqual(before);
	});

	it("rejects invalid widths, missing files and malformed saved history explicitly", () => {
		for (const width of [0, -1, 1.5, NaN, Infinity])
			expect(() => terminalExport.exportSessionToTerminal(path, width)).toThrow(/columns|width/i);
		expect(() => terminalExport.exportSessionToTerminal(path, 80)).toThrow(/session|ENOENT/i);
		for (const contents of ["", "not json\n", '{"type":"message"}\n']) {
			writeFileSync(path, contents);
			expect(() => terminalExport.exportSessionToTerminal(path, 80)).toThrow(/session|header|malformed/i);
		}
		const session = SessionManager.inMemory(dir);
		session.appendMessage({ role: "user", content: "first", timestamp: 0 });
		session.appendMessage(assistant("last"));
		save(path, session);
		const valid = readFileSync(path, "utf8");
		writeFileSync(path, valid.replace("\n", "\nnot-json\n"));
		expect(() => terminalExport.exportSessionToTerminal(path, 80)).toThrow(/malformed/i);
		const entries = valid
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line)) as FileEntry[];
		const leaf = entries.at(-1)!;
		if (leaf.type !== "session") leaf.parentId = leaf.id;
		writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		expect(() => terminalExport.exportSessionToTerminal(path, 80)).toThrow(/parent|cycle/i);
	});
});
