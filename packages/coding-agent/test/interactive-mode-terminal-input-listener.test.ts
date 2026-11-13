import { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

interface ListenerContext {
	ui: TUI;
	extensionTerminalInputUnsubscribers: Set<() => void>;
	showError: (message: string) => void;
	addExtensionTerminalInputListener(handler: TerminalInputHandler): () => void;
}

describe("InteractiveMode extension terminal input listeners", () => {
	it("reports a throwing extension handler instead of letting it escape stdin dispatch", () => {
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TUI(terminal);
		const received: string[] = [];
		ui.setFocus({ render: () => [], invalidate: () => {}, handleInput: (data: string) => received.push(data) });
		const showError = vi.fn();
		const context = Object.assign(Object.create(InteractiveMode.prototype) as ListenerContext, {
			ui,
			extensionTerminalInputUnsubscribers: new Set<() => void>(),
			showError,
		});

		context.addExtensionTerminalInputListener(() => {
			throw new Error("listener bug");
		});
		ui.start();
		try {
			expect(() => terminal.sendInput("x")).not.toThrow();
		} finally {
			ui.stop();
		}

		expect(showError).toHaveBeenCalledWith("Extension terminal input handler failed: listener bug");
		expect(received).toEqual(["x"]);
	});
});
