import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

describe("SettingsManager", () => {
	const testDir = join(process.cwd(), "test-settings-retry-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		// Clean up and create fresh directories
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	describe("retry", () => {
		it("defaults to thirty retries with a thirty-second base and five-minute cap", () => {
			const settingsManager = SettingsManager.inMemory();

			expect(settingsManager.getRetrySettings()).toEqual({
				enabled: true,
				maxRetries: 30,
				baseDelayMs: 30_000,
				maxBackoffMs: 300_000,
			});
		});

		it("preserves session maxBackoffMs when loading and saving unrelated settings", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ retry: { baseDelayMs: 1000, maxBackoffMs: 2500 } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getRetrySettings()).toMatchObject({ baseDelayMs: 1000, maxBackoffMs: 2500 });
			expect(manager.getProviderRetrySettings().maxRetryDelayMs).toBe(60000);
			manager.setTheme("light");
			await manager.flush();
			expect(JSON.parse(readFileSync(settingsPath, "utf-8")).retry).toEqual({
				baseDelayMs: 1000,
				maxBackoffMs: 2500,
			});
		});

		it.each([
			{ maxBackoffMs: undefined, maxRetryDelayMs: undefined, expectedProviderDelayMs: 90000 },
			{ maxBackoffMs: 120000, maxRetryDelayMs: undefined, expectedProviderDelayMs: 90000 },
			{ maxBackoffMs: 120000, maxRetryDelayMs: null, expectedProviderDelayMs: 90000 },
			{ maxBackoffMs: 120000, maxRetryDelayMs: 45000, expectedProviderDelayMs: 45000 },
		])(
			"migrates legacy maxDelayMs only to provider settings with $maxBackoffMs backoff and $maxRetryDelayMs provider cap",
			async ({ maxBackoffMs, maxRetryDelayMs, expectedProviderDelayMs }) => {
				const settingsPath = join(agentDir, "settings.json");
				writeFileSync(
					settingsPath,
					JSON.stringify({ retry: { maxDelayMs: 90000, maxBackoffMs, provider: { maxRetryDelayMs } } }),
				);
				const manager = SettingsManager.create(projectDir, agentDir);
				expect(manager.getRetrySettings()).toMatchObject({ maxBackoffMs: maxBackoffMs ?? 300000 });
				expect(manager.getProviderRetrySettings().maxRetryDelayMs).toBe(expectedProviderDelayMs);
				expect(manager.getMergedSettings().retry).not.toHaveProperty("maxDelayMs");
				manager.setTheme("light");
				await manager.flush();
				expect(JSON.parse(readFileSync(settingsPath, "utf-8")).retry).toEqual({
					...(maxBackoffMs === undefined ? {} : { maxBackoffMs }),
					provider: { maxRetryDelayMs: expectedProviderDelayMs },
				});
				const reloaded = SettingsManager.create(projectDir, agentDir);
				expect(reloaded.getRetrySettings()).toMatchObject({ maxBackoffMs: maxBackoffMs ?? 300000 });
				expect(reloaded.getProviderRetrySettings().maxRetryDelayMs).toBe(expectedProviderDelayMs);
			},
		);

		it("merges project delay settings over global settings", () => {
			const storage = new InMemorySettingsStorage();
			storage.withLock("global", () =>
				JSON.stringify({ retry: { baseDelayMs: 1000, maxBackoffMs: 5000, maxDelayMs: 90000 } }),
			);
			storage.withLock("project", () => JSON.stringify({ retry: { maxBackoffMs: 2500, maxDelayMs: 45000 } }));
			const manager = SettingsManager.fromStorage(storage);
			expect(manager.getRetrySettings()).toMatchObject({ baseDelayMs: 1000, maxBackoffMs: 2500 });
			expect(manager.getProviderRetrySettings().maxRetryDelayMs).toBe(45000);
			expect(manager.getGlobalSettings().retry).toEqual({
				baseDelayMs: 1000,
				maxBackoffMs: 5000,
				provider: { maxRetryDelayMs: 90000 },
			});
			expect(manager.getProjectSettings().retry).toEqual({
				maxBackoffMs: 2500,
				provider: { maxRetryDelayMs: 45000 },
			});
		});

		it.each(["baseDelayMs", "maxBackoffMs"] as const)(
			"rejects invalid retry.%s without substituting defaults",
			(field) => {
				for (const value of [-1, 0.5, NaN, Infinity, 2_147_483_648]) {
					const manager = SettingsManager.inMemory();
					manager.applyOverrides({ retry: { [field]: value } });
					expect(() => manager.getRetrySettings()).toThrow(`Invalid retry.${field} setting`);
				}
				for (const value of [null, "300000", false]) {
					const storage = new InMemorySettingsStorage();
					storage.withLock("global", () => JSON.stringify({ retry: { [field]: value } }));
					expect(() => SettingsManager.fromStorage(storage).getRetrySettings()).toThrow(
						`Invalid retry.${field} setting`,
					);
				}
			},
		);

		it("rejects a cap below the base and accepts zero delays", () => {
			const manager = SettingsManager.inMemory();
			manager.applyOverrides({ retry: { baseDelayMs: 1000, maxBackoffMs: 999 } });
			expect(() => manager.getRetrySettings()).toThrow("retry.maxBackoffMs must be at least retry.baseDelayMs");
			manager.applyOverrides({ retry: { baseDelayMs: 0, maxBackoffMs: 0 } });
			expect(manager.getRetrySettings()).toMatchObject({ baseDelayMs: 0, maxBackoffMs: 0 });
		});
	});
});
