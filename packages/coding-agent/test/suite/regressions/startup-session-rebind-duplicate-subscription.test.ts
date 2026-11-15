import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

type RebindContext = {
	session: object;
	unsubscribe?: () => void;
	clearChildAgentView: () => void;
	cancelPartialUpdateRender: () => void;
	applyRuntimeSettings: () => void;
	renderCurrentSessionState: () => void;
	bindCurrentSessionExtensions: () => Promise<void>;
	subscribeToAgent: () => void;
	updateAvailableProviderCount: () => Promise<void>;
	updateEditorBorderColor: () => void;
	updateTerminalTitle: () => void;
};

type InteractiveModePrototype = {
	rebindCurrentSession(this: RebindContext, options?: { renderBeforeBind?: boolean }): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

// Ported from upstream c2275d670 (#7110).
describe("overlapping startup and replacement session rebinds", () => {
	it("does not subscribe from the stale startup rebind", async () => {
		let resolveStartupBind!: () => void;
		let resolveReplacementBind!: () => void;
		const startupBind = new Promise<void>((resolve) => {
			resolveStartupBind = resolve;
		});
		const replacementBind = new Promise<void>((resolve) => {
			resolveReplacementBind = resolve;
		});
		const subscribeToAgent = vi.fn();
		const updateTerminalTitle = vi.fn();
		let bindCount = 0;

		const context: RebindContext = {
			session: { id: "startup" },
			clearChildAgentView: () => {},
			cancelPartialUpdateRender: () => {},
			applyRuntimeSettings: () => {},
			renderCurrentSessionState: () => {},
			bindCurrentSessionExtensions: () => {
				bindCount += 1;
				return bindCount === 1 ? startupBind : replacementBind;
			},
			subscribeToAgent,
			updateAvailableProviderCount: async () => {},
			updateEditorBorderColor: () => {},
			updateTerminalTitle,
		};

		const startupRebind = interactiveModePrototype.rebindCurrentSession.call(context);
		expect(bindCount).toBe(1);

		context.session = { id: "replacement" };
		const replacementRebind = interactiveModePrototype.rebindCurrentSession.call(context, {
			renderBeforeBind: true,
		});
		expect(bindCount).toBe(2);
		expect(subscribeToAgent).toHaveBeenCalledTimes(1);

		resolveStartupBind();
		await startupRebind;
		expect(subscribeToAgent).toHaveBeenCalledTimes(1);
		expect(updateTerminalTitle).not.toHaveBeenCalled();

		resolveReplacementBind();
		await replacementRebind;
		expect(subscribeToAgent).toHaveBeenCalledTimes(1);
		expect(updateTerminalTitle).toHaveBeenCalledTimes(1);
	});
});
