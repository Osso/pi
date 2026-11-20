import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

it.each(["reload", "write"])("treats a zero-byte settings file as invalid during %s", async (step) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-empty-settings-"));
	const path = join(dir, "settings.json");
	try {
		writeFileSync(path, JSON.stringify({ quietStartup: true }));
		const manager = SettingsManager.create(dir, dir);
		writeFileSync(path, "");

		if (step === "reload") {
			await manager.reload();
			expect(manager.getQuietStartup()).toBe(true);
			expect(manager.drainErrors().map(({ scope }) => scope)).toEqual(["global"]);
		}

		manager.setHideToolOutput(true);
		await manager.flush();
		expect(readFileSync(path, "utf8")).toBe("");
		if (step === "write") {
			expect(manager.drainErrors().map(({ scope }) => scope)).toEqual(["global"]);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
