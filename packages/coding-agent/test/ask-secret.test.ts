import { describe, expect, it, vi } from "vitest";
import { type AskSecretProvisioner, createAskSecretToolDefinition } from "../extensions/ask-secret/src/index.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";

describe("ask_secret extension", () => {
	it("prompts for credentials and returns only non-secret provisioning metadata", async () => {
		const provision = vi.fn<AskSecretProvisioner>().mockResolvedValue(undefined);
		const input = vi
			.fn<NonNullable<ExtensionContext["ui"]["input"]>>()
			.mockResolvedValueOnce("rei-user")
			.mockResolvedValueOnce("super-secret");
		const tool = createAskSecretToolDefinition({ provision });
		const context = {
			mode: "tui",
			hasUI: true,
			ui: { input },
		} as unknown as ExtensionContext;

		const result = await tool.execute(
			"call-1",
			{
				record: "browser/rei-capital-one.json",
				usernameSelector: "#usernameInputField",
				passwordSelector: "#pwInputField",
			},
			undefined,
			undefined,
			context,
		);

		expect(provision).toHaveBeenCalledWith(
			{
				record: "browser/rei-capital-one.json",
				usernameSelector: "#usernameInputField",
				passwordSelector: "#pwInputField",
			},
			"rei-user",
			"super-secret",
			undefined,
		);
		expect(input).toHaveBeenNthCalledWith(2, "Secrets Broker password", "Enter password", { secret: true });
		expect(JSON.stringify(result)).not.toContain("rei-user");
		expect(JSON.stringify(result)).not.toContain("super-secret");
	});

	it("fails closed outside an interactive TUI", async () => {
		const provision = vi.fn<AskSecretProvisioner>();
		const tool = createAskSecretToolDefinition({ provision });
		const result = await tool.execute(
			"call-2",
			{
				record: "browser/rei-capital-one.json",
				usernameSelector: "#usernameInputField",
				passwordSelector: "#pwInputField",
			},
			undefined,
			undefined,
			{ mode: "rpc", hasUI: false } as unknown as ExtensionContext,
		);

		expect(result.content).toEqual([{ type: "text", text: "Error: ask_secret requires an interactive TUI session" }]);
		expect(provision).not.toHaveBeenCalled();
	});

	it("rejects unsafe broker arguments before prompting", async () => {
		const input = vi.fn<NonNullable<ExtensionContext["ui"]["input"]>>();
		const tool = createAskSecretToolDefinition({ provision: vi.fn<AskSecretProvisioner>() });
		const context = { mode: "tui", hasUI: true, ui: { input } } as unknown as ExtensionContext;

		await expect(
			tool.execute(
				"call-3",
				{
					record: "browser/rei-capital-one.json\nleak",
					usernameSelector: "#usernameInputField",
					passwordSelector: "#pwInputField",
				},
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow("record must not contain control characters");
		expect(input).not.toHaveBeenCalled();
	});
});
