import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestSession } from "./utilities.ts";

describe("test session isolation", () => {
	it("stores persisted utility sessions inside the owned temporary directory", () => {
		const context = createTestSession();
		try {
			expect(context.sessionManager.getSessionDir()).toBe(join(context.tempDir, "sessions"));
		} finally {
			context.cleanup();
		}
	});
});
