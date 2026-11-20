import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as TuiModule from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { selectConfig } from "../src/cli/config-selector.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

vi.mock("@earendil-works/pi-tui", async (importOriginal) => ({
	...(await importOriginal<typeof TuiModule>()),
	ProcessTerminal: class extends VirtualTerminal {
		constructor() {
			super(80, 40);
			terminal = this;
		}
	},
}));

let terminal: VirtualTerminal;

it("keeps the highlighted config resource in the viewport after a height change", async () => {
	const agentDir = join(tmpdir(), "config-selector-resize");
	const skills = Array.from({ length: 40 }, (_, index) => ({
		path: join(agentDir, "skills", `skill-${String(index + 1).padStart(2, "0")}`, "SKILL.md"),
		enabled: true,
		metadata: { source: "auto", scope: "user" as const, origin: "top-level" as const },
	}));
	const closed = selectConfig({
		resolvedPaths: { extensions: [], skills, prompts: [], themes: [] },
		settingsManager: SettingsManager.inMemory(),
		cwd: agentDir,
		agentDir,
	});
	try {
		await expect.poll(() => terminal.getViewport().some((line) => /^>.*\[x\] skill-01$/.test(line))).toBe(true);
		terminal.resize(80, 24);
		await terminal.waitForRender();
		await expect.poll(() => terminal.getViewport().some((line) => /^>.*\[x\] skill-01$/.test(line))).toBe(true);
	} finally {
		terminal.sendInput("\x1b");
		await closed;
	}
});
