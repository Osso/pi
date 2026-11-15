import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSettingsStorage } from "../src/core/settings-manager.ts";

describe("FileSettingsStorage.withLock", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("keeps settings another process wrote while the file was being created", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-settings-lock-"));
		const agentDir = join(tempDir, "agent");
		const settingsPath = join(agentDir, "settings.json");
		const storage = new FileSettingsStorage(join(tempDir, "project"), agentDir);
		let otherProcessWrote = false;

		storage.withLock("global", (current) => {
			if (!otherProcessWrote) {
				otherProcessWrote = true;
				mkdirSync(agentDir, { recursive: true });
				writeFileSync(settingsPath, JSON.stringify({ theme: "light" }));
			}
			return JSON.stringify({ ...(current ? JSON.parse(current) : {}), defaultModel: "model-a" });
		});

		expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ theme: "light", defaultModel: "model-a" });
	});
});
