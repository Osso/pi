import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectSession } from "../src/cli/session-picker.ts";

const pickerMocks = vi.hoisted(() => {
	const ui = {
		addChild: vi.fn(),
		setFocus: vi.fn(),
		stop: vi.fn(),
		requestRender: vi.fn(),
	};
	return {
		ui,
		onSelect: undefined as ((path: string) => void) | undefined,
		showError: vi.fn(),
	};
});

vi.mock("../src/cli/startup-ui.ts", () => ({
	createStartupTui: vi.fn(async () => pickerMocks.ui),
	startStartupTui: vi.fn(),
}));

vi.mock("../src/modes/interactive/components/session-selector.ts", () => ({
	SessionSelectorComponent: class {
		constructor(
			_currentSessionsLoader: unknown,
			_allSessionsLoader: unknown,
			onSelect: (path: string) => void,
		) {
			pickerMocks.onSelect = onSelect;
		}

		getSessionList(): object {
			return {};
		}

		showError(message: string): void {
			pickerMocks.showError(message);
		}
	},
}));

describe("session picker selection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		pickerMocks.onSelect = undefined;
	});

	it("keeps the picker open when validating the selected session fails", async () => {
		let rejectSelection = true;
		const selection = selectSession(
			async () => [],
			async () => [],
			{} as never,
			undefined,
			undefined,
			() => {
				if (rejectSelection) throw new Error("Session is open in another Pi process");
			},
		);
		await Promise.resolve();

		expect(pickerMocks.onSelect).toBeDefined();
		pickerMocks.onSelect?.("/sessions/open.jsonl");
		await Promise.resolve();

		expect(pickerMocks.ui.stop).not.toHaveBeenCalled();
		expect(pickerMocks.showError).toHaveBeenCalledWith("Session is open in another Pi process");

		rejectSelection = false;
		pickerMocks.onSelect?.("/sessions/available.jsonl");

		await expect(selection).resolves.toBe("/sessions/available.jsonl");
		expect(pickerMocks.ui.stop).toHaveBeenCalledOnce();
	});
});
