import assert from "node:assert/strict";
import { SessionManager } from "../../src/core/session-manager.ts";

const baselineKiB = process.resourceUsage().maxRSS;
const file = process.argv[2];
if (!file) throw new Error("Expected session path");
const manager = file.endsWith(".jsonl.zst") ? SessionManager.openReadOnly(file) : SessionManager.open(file);
const entries = manager.getEntries();
const context = manager.buildSessionContext();
console.log(
	JSON.stringify({
		baselineKiB,
		peakKiB: process.resourceUsage().maxRSS,
		loadedEntries: entries.length,
		contextBytes: Buffer.byteLength(JSON.stringify(context)),
	}),
);
assert.equal(context.messages.length, 2);
assert.equal(context.messages[1].role, "user");
