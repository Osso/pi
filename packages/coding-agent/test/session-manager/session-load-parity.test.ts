import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportFromFile } from "../../src/core/export-html/index.ts";
import { exportSessionToTerminal } from "../../src/core/export-terminal.ts";
import { archivePersistedSession } from "../../src/core/session-archive-storage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createSearchCurrentSessionHistoryToolDefinition } from "../../src/core/tools/search-current-session-history.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { loadedSessionState, sessionLoadFixture } from "./session-load-fixtures.ts";

// Captured from origin/master af8182e1f's plain loader, before changing either loader.
const baseline = JSON.parse(readFileSync(new URL("./session-load-baseline.json", import.meta.url), "utf8"));
const cases = [0, 1, 2].flatMap((compactions) => [false, true].map((cwd) => ({ compactions, cwd })));

function exportedPayload(file: string): unknown {
	const html = readFileSync(file, "utf8");
	const encoded = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(html)?.[1];
	if (!encoded) throw new Error("Missing exported session payload");
	return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

function forkState(manager: SessionManager) {
	const { header, ...state } = loadedSessionState(manager);
	return { ...state, headerCwd: header?.cwd, headerVersion: header?.version };
}

describe("plain/archive session load parity", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-session-load-parity-"));
		initTheme("dark", false);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it.each(cases)(
		"preserves baseline state and caller outputs ($compactions compactions, cwd=$cwd)",
		async ({ compactions, cwd }) => {
			const plain = join(root, "session.jsonl");
			const archive = `${plain}.zst`;
			const content = `${sessionLoadFixture(compactions, cwd)
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`;
			writeFileSync(plain, content);
			writeFileSync(archive, zstdCompressSync(content));
			const original = Buffer.from(content);
			const expected = baseline[`${compactions}-${cwd}`];
			const writable = SessionManager.open(plain, root);
			const viewedPlain = SessionManager.openReadOnly(plain, root);
			const viewedArchive = SessionManager.openReadOnly(archive, root);
			// Child-agent viewer initial open and reload consume this exact manager state.
			expect(JSON.parse(JSON.stringify(loadedSessionState(writable)))).toEqual(expected);
			expect(JSON.parse(JSON.stringify(loadedSessionState(viewedPlain)))).toEqual(expected);
			expect(JSON.parse(JSON.stringify(loadedSessionState(viewedArchive)))).toEqual(expected);

			const tool = createSearchCurrentSessionHistoryToolDefinition();
			for (const context_entries of [0, 2]) {
				const search = (sessionManager: SessionManager) =>
					tool.execute("parity", { query: "needle", context_entries, limit: 2 }, undefined, undefined, {
						sessionManager,
					} as unknown as Parameters<typeof tool.execute>[4]);
				expect(await search(viewedArchive)).toEqual(await search(viewedPlain));
			}
			const plainHtml = await exportFromFile(plain, join(root, "plain.html"));
			const archiveHtml = await exportFromFile(archive, join(root, "archive.html"));
			expect(exportedPayload(archiveHtml)).toEqual(exportedPayload(plainHtml));
			expect(exportSessionToTerminal(archive, 80)).toEqual(exportSessionToTerminal(plain, 80));

			const plainFork = SessionManager.forkFrom(plain, "/fork", join(root, "plain-forks"));
			const archiveFork = SessionManager.forkFrom(archive, "/fork", join(root, "archive-forks"));
			expect(forkState(archiveFork)).toEqual(forkState(plainFork));
			expect(plainFork.getHeader()?.parentSession).toBe(plain);
			expect(archiveFork.getHeader()?.parentSession).toBe(archive);
			expect(readFileSync(plain)).toEqual(original);
			expect(existsSync(archive)).toBe(true);
		},
	);

	it("preserves SQLite metadata and goal references when a compacted source is archived", () => {
		const plain = join(root, "metadata.jsonl");
		writeFileSync(
			plain,
			`${sessionLoadFixture(2, true)
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const db = join(root, "control.sqlite");
		const source = SessionManager.open(plain, root);
		source.setMetadataControlDbPath(db);
		source.setSessionName("Named source");
		source.setSessionGoalJson('{"objective":"preserve source goal"}');
		source.setSessionModel("openai", "stored-model");
		source.setSessionThinkingLevel("high");
		const expectedState = loadedSessionState(source);
		const expectedSettings = source.readPersistedSessionSettings();
		const expectedGoal = source.getSessionGoalJsonForSession(plain);
		const archive = archivePersistedSession(db, plain);
		const viewed = SessionManager.openReadOnly(archive, root);
		viewed.setMetadataControlDbPath(db);
		expect(loadedSessionState(viewed)).toEqual(expectedState);
		expect(viewed.readPersistedSessionSettings()).toEqual(expectedSettings);
		expect(viewed.getSessionGoalJson()).toBe(expectedGoal);
		expect(viewed.getSessionGoalJsonForSession(plain)).toBe(expectedGoal);
		const fork = SessionManager.forkFrom(archive, "/fork", join(root, "forks"));
		fork.setMetadataControlDbPath(db);
		expect(fork.getSessionGoalJsonForSession(plain)).toBe(expectedGoal);
		expect(existsSync(plain)).toBe(false);
	});
});
