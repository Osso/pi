import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getControlDbPath, readSessionMetadata } from "../src/core/session-control-db.ts";
import { createTestSession } from "./utilities.ts";

describe("test session isolation", () => {
	it("stores persisted utility sessions and metadata inside the owned temporary directory", () => {
		const context = createTestSession();
		try {
			expect(context.sessionManager.getSessionDir()).toBe(join(context.tempDir, "sessions"));
			const sessionFile = context.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Missing persisted test session file");
			expect(readSessionMetadata(getControlDbPath(context.tempDir), sessionFile)).toMatchObject({
				cwd: context.tempDir,
			});
		} finally {
			context.cleanup();
		}
	});
});
