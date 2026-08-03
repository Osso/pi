import { SessionManager } from "../../src/core/session-manager.ts";

const sessionFile = process.argv[2];
if (!sessionFile) {
	throw new Error("Expected session file path");
}

const session = SessionManager.open(sessionFile);
const entryIds = session.getEntries().map((entry) => entry.id);
process.stdout.write(JSON.stringify(entryIds));
