import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AUTO_DETACH_AFTER_MS, ToolDetachRegistry } from "../src/core/tool-detach-registry.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("ToolDetachRegistry", () => {
	it("uses a five-minute default auto-detach threshold", () => {
		vi.useFakeTimers();
		const detach = vi.fn(() => true);
		const unregister = new ToolDetachRegistry().register({ detach });

		expect(DEFAULT_AUTO_DETACH_AFTER_MS).toBe(300_000);
		vi.advanceTimersByTime(299_999);
		expect(detach).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(detach).toHaveBeenCalledOnce();
		unregister();
	});
});
