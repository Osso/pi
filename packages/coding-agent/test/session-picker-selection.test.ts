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
		currentSessionsLoader: undefined as (() => Promise<Array<{ path: string; name?: string }>>) | undefined,
		archivedSessionsLoader: undefined as (() => Promise<Array<{ path: string; name?: string }>>) | undefined,
		onSelect: undefined as ((path: string) => void) | undefined,
		showError: vi.fn(),
	};
});

vi.mock("../src/cli/startup-ui.ts", () => ({
	createStartupTui: vi.fn(async () => pickerMocks.ui),
	startStartupTui: vi.fn(),
}));

vi.mock("../src/core/session-control-db.ts", () => ({
	listNamedSessions: vi.fn(() => [{ sessionPath: "/sessions/older.jsonl", name: "Older named" }]),
}));

vi.mock("../src/modes/interactive/components/session-selector.ts", () => ({
	SessionSelectorComponent: class {
		constructor(
			currentSessionsLoader: () => Promise<Array<{ path: string; name?: string }>>,
			_allSessionsLoader: unknown,
			onSelect: (path: string) => void,
			_onCancel: unknown,
			_onExit: unknown,
			_requestRender: unknown,
			options?: { archivedSessionsLoader?: () => Promise<Array<{ path: string; name?: string }>> },
		) {
			pickerMocks.currentSessionsLoader = currentSessionsLoader;
			pickerMocks.archivedSessionsLoader = options?.archivedSessionsLoader;
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
		pickerMocks.currentSessionsLoader = undefined;
		pickerMocks.archivedSessionsLoader = undefined;
		pickerMocks.onSelect = undefined;
	});

	it("keeps named-first ordering out of archived sessions", async () => {
		const newer = {
			path: "/sessions/newer.jsonl",
			name: undefined,
			modified: new Date("2026-07-29T02:00:00Z"),
			isArchived: true,
		};
		const older = {
			path: "/sessions/older.jsonl",
			name: undefined,
			modified: new Date("2026-07-29T01:00:00Z"),
			isArchived: true,
		};

		void selectSession(
			async () =>
				[
					{ ...newer, isArchived: false },
					{ ...older, isArchived: false },
				] as never,
			async () => [],
			{} as never,
			"/control.sqlite",
			async () => [newer, older] as never,
		);
		await Promise.resolve();

		const currentSessions = await pickerMocks.currentSessionsLoader?.();
		const archivedSessions = await pickerMocks.archivedSessionsLoader?.();

		expect(currentSessions?.map((session) => session.path)).toEqual([older.path, newer.path]);
		expect(archivedSessions?.map((session) => session.path)).toEqual([newer.path, older.path]);
		expect(archivedSessions?.find((session) => session.path === older.path)?.name).toBe("Older named");
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
