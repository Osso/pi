import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, shouldCompact } from "../src/core/compaction/compaction.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

describe("compaction.thresholdTokens", () => {
	it.each([922_000, 1_050_000])("triggers exactly at 500k tokens in a %i-token window", (contextWindow) => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, thresholdTokens: 500_000 };
		expect(shouldCompact(499_999, contextWindow, settings)).toBe(false);
		expect(shouldCompact(500_000, contextWindow, settings)).toBe(true);
	});

	it("keeps the reserve trigger for windows at or below the token threshold", () => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, thresholdTokens: 500_000, reserveTokens: 10_000 };
		expect(shouldCompact(490_000, 500_000, settings)).toBe(false);
		expect(shouldCompact(490_001, 500_000, settings)).toBe(true);
	});

	it("overrides both lower and higher model thresholds", () => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, thresholdTokens: 100_000 };
		expect(shouldCompact(99_999, 200_000, settings, 80_000)).toBe(false);
		expect(shouldCompact(100_000, 200_000, settings, 180_000)).toBe(true);
	});

	it("preserves the strict reserve boundary and inclusive model boundary when unset", () => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 10_000 };
		expect(shouldCompact(190_000, 200_000, settings)).toBe(false);
		expect(shouldCompact(190_001, 200_000, settings)).toBe(true);
		expect(shouldCompact(179_999, 200_000, settings, 180_000)).toBe(false);
		expect(shouldCompact(180_000, 200_000, settings, 180_000)).toBe(true);
	});

	it("preserves disabled semantics", () => {
		expect(
			shouldCompact(500_000, 1_000_000, { ...DEFAULT_COMPACTION_SETTINGS, enabled: false, thresholdTokens: 1 }),
		).toBe(false);
	});

	it("loads the configured token count without changing budgets", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ compaction: { thresholdTokens: 500_000 } }));
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getCompactionSettings()).toEqual({ ...DEFAULT_COMPACTION_SETTINGS, thresholdTokens: 500_000 });
	});

	it("propagates merged project settings and runtime overrides", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({ compaction: { thresholdTokens: 600_000, reserveTokens: 12345 } }),
		);
		storage.withLock("project", () => JSON.stringify({ compaction: { thresholdTokens: 500_000 } }));
		const manager = SettingsManager.fromStorage(storage);
		expect(shouldCompact(500_000, 1_000_000, manager.getCompactionSettings())).toBe(true);
		manager.applyOverrides({ compaction: { thresholdTokens: 400_000 } });
		expect(shouldCompact(400_000, 1_000_000, manager.getCompactionSettings())).toBe(true);
		expect(manager.getCompactionReserveTokens()).toBe(12345);
	});

	it.each([0, -1, 1.5, NaN, Infinity, "500000", null])(
		"rejects invalid token count %s with an actionable error",
		(value) => {
			const manager = SettingsManager.inMemory();
			manager.applyOverrides({ compaction: { thresholdTokens: value as number } });
			expect(() => manager.getCompactionSettings()).toThrow(/compaction\.thresholdTokens.*positive integer/);
		},
	);
});
