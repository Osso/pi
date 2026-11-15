import { resetCapabilitiesCache, setCapabilities, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

const imageConvertMocks = vi.hoisted(() => ({ convertToPng: vi.fn() }));

vi.mock("../src/utils/image-convert.ts", () => imageConvertMocks);

import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
		addInterval: () => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestComponentRender: () => false,
	} as unknown as TUI;
}

describe("ToolExecutionComponent image conversion", () => {
	beforeAll(() => initTheme("dark"));

	afterEach(() => {
		resetCapabilitiesCache();
		imageConvertMocks.convertToPng.mockReset();
	});

	// Issue #8577: ignore conversions that finish after the image was replaced.
	test("keeps the final tool image when a partial image conversion finishes late", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		let finishConversion!: (result: { data: string; mimeType: string }) => void;
		const conversion = new Promise<{ data: string; mimeType: string }>((resolve) => {
			finishConversion = resolve;
		});
		imageConvertMocks.convertToPng.mockReturnValue(conversion);
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-image-race",
			{},
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);

		component.updateResult(
			{ content: [{ type: "image", data: "partial-jpeg", mimeType: "image/jpeg" }], isError: false },
			true,
		);
		component.updateResult({
			content: [{ type: "image", data: "final-png", mimeType: "image/png" }],
			isError: false,
		});
		expect(component.render(120).join("\n")).toContain("final-png");

		finishConversion({ data: "converted-partial", mimeType: "image/png" });
		await conversion;

		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("final-png");
		expect(rendered).not.toContain("converted-partial");
	});
});
