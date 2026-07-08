import { describe, expect, it, vi } from "vitest";
import effortExtension from "../extensions/effort/src/index.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

function createCommandHarness(options?: { reasoning?: boolean; thinkingLevel?: string }) {
	let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
	const setThinkingLevel = vi.fn();
	const pi = {
		getThinkingLevel: () => options?.thinkingLevel ?? "off",
		registerCommand: (_name: string, registeredCommand: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			command = registeredCommand;
		},
		setThinkingLevel,
	} as unknown as ExtensionAPI;

	effortExtension(pi);

	const notify = vi.fn();
	const setEditorText = vi.fn();
	const ctx = {
		model: {
			id: "reasoner",
			provider: "test",
			contextWindow: 200_000,
			reasoning: options?.reasoning ?? true,
		},
		ui: { notify, setEditorText },
	} as unknown as ExtensionCommandContext;

	if (!command) throw new Error("/effort command was not registered");
	return { command, ctx, notify, setEditorText, setThinkingLevel };
}

describe("effort extension", () => {
	it("keeps /effort out of built-in slash commands", () => {
		expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).not.toContain("effort");
	});

	it("registers /effort from the extension", () => {
		const { command } = createCommandHarness();

		expect(command.description).toBe("Set model effort level (depends on selected model)");
	});

	it("sets a valid model-supported effort", async () => {
		const { command, ctx, notify, setEditorText, setThinkingLevel } = createCommandHarness({ thinkingLevel: "high" });

		await command.handler("high", ctx);

		expect(setThinkingLevel).toHaveBeenCalledWith("high");
		expect(notify).toHaveBeenCalledWith("Effort: high", "info");
		expect(setEditorText).toHaveBeenCalledWith("");
	});

	it("rejects effort levels unsupported by the current model", async () => {
		const { command, ctx, notify, setThinkingLevel } = createCommandHarness({ reasoning: false });

		await command.handler("high", ctx);

		expect(setThinkingLevel).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith('Invalid effort "high". Available: off', "warning");
	});
});
