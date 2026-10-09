import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, shouldCompact } from "../src/core/compaction/compaction.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

describe("compaction.thresholdPercent", () => {
	it.each([200_000, 1_000_000])("triggers exactly at 50%% of a %i-token window", (contextWindow) => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, thresholdPercent: 50 };
		expect(shouldCompact(contextWindow / 2 - 1, contextWindow, settings)).toBe(false);
		expect(shouldCompact(contextWindow / 2, contextWindow, settings)).toBe(true);
	});

	it("overrides both lower and higher model thresholds", () => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, thresholdPercent: 50 };
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
			shouldCompact(200_000, 200_000, { ...DEFAULT_COMPACTION_SETTINGS, enabled: false, thresholdPercent: 50 }),
		).toBe(false);
	});

	it.each([0.5, 50, 100])("loads and propagates valid percentage %s without changing budgets", (thresholdPercent) => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ compaction: { thresholdPercent } }));
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getCompactionSettings()).toEqual({ ...DEFAULT_COMPACTION_SETTINGS, thresholdPercent });
	});

	it("propagates merged project settings and runtime overrides", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ compaction: { thresholdPercent: 60, reserveTokens: 12345 } }));
		storage.withLock("project", () => JSON.stringify({ compaction: { thresholdPercent: 50 } }));
		const manager = SettingsManager.fromStorage(storage);
		expect(shouldCompact(100_000, 200_000, manager.getCompactionSettings())).toBe(true);
		manager.applyOverrides({ compaction: { thresholdPercent: 40 } });
		expect(shouldCompact(80_000, 200_000, manager.getCompactionSettings())).toBe(true);
		expect(manager.getCompactionReserveTokens()).toBe(12345);
	});

	it.each([0, -1, 100.1, NaN, Infinity, -Infinity, "50", null])(
		"rejects invalid percentage %s with an actionable error",
		(value) => {
			const manager = SettingsManager.inMemory();
			manager.applyOverrides({ compaction: { thresholdPercent: value as number } });
			expect(() => manager.getCompactionSettings()).toThrow(/compaction\.thresholdPercent.*finite number.*0.*100/);
		},
	);

	it.each([0, -1, 101, NaN, Infinity])("rejects invalid direct trigger percentage %s", (thresholdPercent) => {
		expect(() => shouldCompact(100_000, 200_000, { ...DEFAULT_COMPACTION_SETTINGS, thresholdPercent })).toThrow(
			/compaction\.thresholdPercent.*finite number.*0.*100/,
		);
	});
});
