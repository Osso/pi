import { beforeAll, describe, expect, test } from "vitest";
import {
	createSupervisorStatusEntryRenderer,
	renderSupervisorMessage,
	supervisorInstructionContent,
} from "../extensions/goal/src/rendering.ts";
import { createWaitCountdownRefresher } from "../extensions/goal/src/wait-countdown.ts";
import type { EntryRenderer } from "../src/core/extensions/types.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("Supervisor heading spacing", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("message has no inner vertical padding and preserves body spacing", () => {
		const component = renderSupervisorMessage(
			{
				role: "custom",
				customType: "supervisor",
				content: supervisorInstructionContent("Build finished.\n\nArtifacts verified."),
				display: true,
				timestamp: 1,
			},
			{ expanded: false },
			theme,
		);

		expect(component?.render(80).map((line) => stripAnsi(line).trim())).toEqual([
			"[Supervisor]",
			"Build finished.",
			"",
			"Artifacts verified.",
		]);
	});

	test("status completion replaces waiting text without adding a heading gap", () => {
		const renderer = createSupervisorStatusEntryRenderer(createWaitCountdownRefresher());
		const entry: Parameters<EntryRenderer>[0] = {
			type: "custom",
			customType: "supervisor-status",
			id: "waiting",
			parentId: null,
			timestamp: "2026-11-10T00:00:00.000Z",
			data: { message: "Waiting for Supervisor…", displayId: "review" },
		};
		const options = { expanded: false, sessionId: "spacing-test" };
		const component = renderer(entry, options, theme);
		expect(component?.render(80).map((line) => stripAnsi(line).trim())).toEqual([
			"[Supervisor]",
			"Waiting for Supervisor…",
		]);

		const updated = renderer(
			{ ...entry, id: "completed", data: { message: "Review finished.", displayId: "review" } },
			options,
			theme,
		);
		expect(updated).toBeUndefined();
		expect(component?.render(80).map((line) => stripAnsi(line).trim())).toEqual(["[Supervisor]", "Review finished."]);
	});
});
