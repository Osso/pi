import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { getControlDbPath, readSessionMetadata } from "../../../src/core/session-control-db.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

function readPersistedEntryTypes(sessionFile: string): string[] {
	return readFileSync(sessionFile, "utf8")
		.trim()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => (JSON.parse(line) as { type: string }).type);
}

describe("regression #3686: session name changes emit an event", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("emits session_info_changed when AgentSession.setSessionName is called", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.setSessionName("hello world");

		expect(harness.sessionManager.getSessionName()).toBe("hello world");
		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual(["hello world"]);
	});

	it("persists set and clear only through session metadata", async () => {
		const harness = await createHarness({ persistedSession: true });
		harnesses.push(harness);
		const sessionFile = harness.session.sessionFile;
		if (!sessionFile) throw new Error("Expected persisted session file");
		const controlDbPath = getControlDbPath(harness.tempDir);

		harness.session.setSessionName("SQLite Session Name");
		harness.sessionManager.persistForRecovery();
		const nameAfterSet = readSessionMetadata(controlDbPath, sessionFile)?.name;
		const entryTypesAfterSet = readPersistedEntryTypes(sessionFile);

		harness.session.clearSessionName();
		const nameAfterClear = readSessionMetadata(controlDbPath, sessionFile)?.name;
		const entryTypesAfterClear = readPersistedEntryTypes(sessionFile);

		expect({
			nameAfterSet,
			nameAfterClear,
			sessionInfoEntriesAfterSet: entryTypesAfterSet.filter((type) => type === "session_info"),
			sessionInfoEntriesAfterClear: entryTypesAfterClear.filter((type) => type === "session_info"),
		}).toEqual({
			nameAfterSet: "SQLite Session Name",
			nameAfterClear: undefined,
			sessionInfoEntriesAfterSet: [],
			sessionInfoEntriesAfterClear: [],
		});
	});

	it("emits session_info_changed when an extension calls pi.setSessionName", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);

		api?.setSessionName("from extension");

		expect(harness.sessionManager.getSessionName()).toBe("from extension");
		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual(["from extension"]);
	});

	it("emits session_info_changed to extensions", async () => {
		let api: ExtensionAPI | undefined;
		const events: Array<{ name: string | undefined }> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("session_info_changed", (event) => {
						events.push({ name: event.name });
					});
				},
			],
		});
		harnesses.push(harness);

		api?.setSessionName("first");
		harness.session.setSessionName("second");
		harness.session.clearSessionName();

		expect(events).toEqual([{ name: "first" }, { name: "second" }, { name: undefined }]);
	});
});
