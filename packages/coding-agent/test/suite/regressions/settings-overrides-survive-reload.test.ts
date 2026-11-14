import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

// docs/sdk.md: settingsManager.applyOverrides(...) before createAgentSession({ settingsManager }), which reloads it.
describe("SDK settings overrides", () => {
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-settings-overrides-"));
		agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ compaction: { enabled: true }, retry: { maxRetries: 30 } }),
		);
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	function createOverriddenManager(): SettingsManager {
		const manager = SettingsManager.create(cwd, agentDir);
		manager.applyOverrides({ compaction: { enabled: false }, retry: { maxRetries: 5 } });
		return manager;
	}

	it("stay in effect after the resource loader reloads settings", async () => {
		const manager = createOverriddenManager();
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: manager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});

		await loader.reload();

		expect(manager.getCompactionEnabled()).toBe(false);
		expect(manager.getRetrySettings().maxRetries).toBe(5);
	});

	it("stay in effect after an unrelated setter, without being written to disk", async () => {
		const manager = createOverriddenManager();

		manager.setTheme("light");
		await manager.flush();

		expect(manager.getCompactionEnabled()).toBe(false);
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"))).toEqual({
			compaction: { enabled: true },
			retry: { maxRetries: 30 },
			theme: "light",
		});
	});
});
