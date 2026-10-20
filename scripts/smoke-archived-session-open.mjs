// Usage: node scripts/smoke-archived-session-open.mjs /absolute/path/to/compiled/pi
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdCompress } from "node:zlib";

const binary = process.argv[2];
assert(binary, "Pass the compiled Pi executable path");
const root = mkdtempSync(join(tmpdir(), "pi-archive-open-smoke-"));
const spool = join(root, "spool");
mkdirSync(spool);
const archive = join(root, "session.jsonl.zst");
const output = join(root, "session.html");
const timestamp = "2026-10-20T00:00:00.000Z";
function* transcript() {
	yield `${JSON.stringify({ type: "session", version: 3, id: "compiled-archive-smoke", timestamp, cwd: root })}\n`;
	let parentId = null;
	for (let index = 0; index < 2048; index++) {
		const id = `old-${index}`;
		yield `${JSON.stringify({ type: "message", id, parentId, timestamp, message: { role: "user", content: "x".repeat(16384), timestamp: 1 } })}\n`;
		parentId = id;
	}
	yield `${JSON.stringify({ type: "message", id: "retained", parentId, timestamp, message: { role: "user", content: "retained", timestamp: 2 } })}\n`;
	yield `${JSON.stringify({ type: "compaction", id: "compact", parentId: "retained", timestamp, summary: "summary", firstKeptEntryId: "retained", tokensBefore: 999 })}\n`;
}
try {
	await pipeline(Readable.from(transcript()), createZstdCompress(), createWriteStream(archive));
	const before = readFileSync(archive);
	const child = spawnSync(resolve(binary), ["--export", archive, output], {
		cwd: root,
		encoding: "utf8",
		timeout: 90_000,
		env: {
			...process.env,
			HOME: join(root, "home"),
			PI_CODING_AGENT_DIR: join(root, "agent"),
			PI_CODING_AGENT_STATE_DIR: join(root, "state"),
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_STATE_HOME: join(root, "state"),
			XDG_CACHE_HOME: join(root, "cache"),
			TMPDIR: spool,
		},
	});
	assert.equal(child.status, 0, child.stderr || String(child.error));
	const encoded = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(readFileSync(output, "utf8"))?.[1];
	assert(encoded, "HTML export must contain loaded session data");
	const loaded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	const loadedEntryIds = loaded.entries.map((entry) => entry.id);
	assert.deepEqual(loadedEntryIds, ["retained", "compact"]);
	assert.deepEqual(readdirSync(spool), [], "Temporary transcript spool must be removed");
	assert.deepEqual(readFileSync(archive), before);
	assert.equal(existsSync(archive.slice(0, -4)), false);
	console.log(JSON.stringify({ binary: resolve(binary), loadedEntryIds, archiveUnchanged: true, spoolCleaned: true }));
} finally {
	rmSync(root, { recursive: true, force: true });
}
