import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { archiveIdleSessionTranscripts } from "../../src/core/idle-session-archive.ts";

const [root, file, db, point, now] = process.argv.slice(2);
const link = fs.linkSync;
fs.linkSync = (source, target) => {
	link(source, target);
	if (String(target) === `${file}.zst` && point === "after-link") process.kill(process.pid, "SIGKILL");
};
const unlink = fs.unlinkSync;
fs.unlinkSync = (path) => {
	if (String(path) === file && point === "before-unlink") process.kill(process.pid, "SIGKILL");
	unlink(path);
	if (String(path) === file && point === "after-unlink") process.kill(process.pid, "SIGKILL");
};
syncBuiltinESMExports();
await archiveIdleSessionTranscripts(db, { agentDir: root, now: Number(now) });
throw new Error(`Did not reach archival crash point: ${point}`);
