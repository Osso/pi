import { stripVTControlCharacters } from "node:util";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { AgentSnapshot } from "../src/core/multi-agent-store.ts";
import { AgentSwitcherComponent } from "../src/modes/interactive/components/agent-switcher.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function agent(overrides: Partial<AgentSnapshot> & Pick<AgentSnapshot, "id" | "displayName">): AgentSnapshot {
	const { displayName, id, ...rest } = overrides;
	return {
		agentType: "worker",
		createdAt: "2026-06-30T00:00:00.000Z",
		cwd: "/repo",
		displayName,
		id,
		lifecycle: "queued",
		parentId: undefined,
		permission: { narrowed: true, policy: "on-request" },
		revision: 1,
		updatedAt: "2026-06-30T00:00:00.000Z",
		...rest,
	};
}

function renderedText(component: AgentSwitcherComponent, width = 100): string {
	return component
		.render(width)
		.map((line) => stripVTControlCharacters(line))
		.join("\n");
}

describe("AgentSwitcherComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("renders slot row index display name id lifecycle type and selected marker", () => {
		const component = new AgentSwitcherComponent(
			[
				agent({ id: "agent-1", displayName: "Scout", lifecycle: "running", slot: { index: 2, pinned: true } }),
				agent({ id: "agent-2", displayName: "Builder", agentType: "background", lifecycle: "waiting_for_input" }),
			],
			"agent-2",
			() => {},
			() => {},
		);

		const text = renderedText(component);

		expect(text).toContain("Agents");
		expect(text).toContain("#2");
		expect(text).toContain("2.");
		expect(text).toContain("Scout");
		expect(text).toContain("agent-1");
		expect(text).toContain("running");
		expect(text).toContain("worker");
		expect(text).toContain("selected");
		expect(text).toContain("Builder");
		expect(text).toContain("waiting for input");
	});

	it("selects the highlighted agent by id without receiving mutation inputs", () => {
		const onSelect = vi.fn();
		const component = new AgentSwitcherComponent(
			[
				agent({ id: "agent-1", displayName: "Scout" }),
				agent({ id: "agent-2", displayName: "Builder", lifecycle: "running" }),
			],
			"agent-1",
			onSelect,
			() => {},
		);

		component.handleInput("\u001b[B");
		component.handleInput("\r");

		expect(onSelect).toHaveBeenCalledWith("agent-2");
	});

	it("hides inactive agents by default", () => {
		const component = new AgentSwitcherComponent(
			[
				agent({ id: "agent-1", displayName: "Scout" }),
				agent({ id: "agent-2", displayName: "Done", lifecycle: "completed" }),
			],
			"agent-1",
			() => {},
			() => {},
		);

		const text = renderedText(component);

		expect(text).toContain("Scout");
		expect(text).toContain("1 closed agent hidden");
		expect(text).not.toContain("Done");
		expect(text).not.toContain("completed inactive");
	});

	it("toggles inactive agents and refuses to select them", () => {
		setKeybindings(new KeybindingsManager({ "app.agent.toggleClosed": "ctrl+x" }));
		const onSelect = vi.fn();
		const component = new AgentSwitcherComponent(
			[
				agent({ id: "agent-1", displayName: "Scout" }),
				agent({ id: "agent-2", displayName: "Done", lifecycle: "completed" }),
			],
			"agent-1",
			onSelect,
			() => {},
		);

		component.handleInput("\u0018");
		component.handleInput("\u001b[B");
		component.handleInput("\r");

		const text = renderedText(component);
		expect(text).toContain("Done");
		expect(text).toContain("completed inactive");
		expect(text).toContain("Showing 1 closed agent");
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("does not hardcode enter when confirm is remapped", () => {
		setKeybindings(new KeybindingsManager({ "tui.select.confirm": "ctrl+x" }));
		const onSelect = vi.fn();
		const component = new AgentSwitcherComponent(
			[agent({ id: "agent-1", displayName: "Scout" })],
			"agent-1",
			onSelect,
			() => {},
		);

		component.handleInput("\r");
		component.handleInput("\u0018");

		expect(onSelect).toHaveBeenCalledOnce();
		expect(onSelect).toHaveBeenCalledWith("agent-1");
	});

	it("renders main thread as current when no child agents exist", () => {
		const onCancel = vi.fn();
		const component = new AgentSwitcherComponent([], undefined, () => {}, onCancel);
		const text = renderedText(component);

		expect(text).toContain("Main thread");
		expect(text).toContain("current");
		expect(text).not.toContain("No agents");
	});

	it("renders main thread as a selectable current row above child agents", () => {
		const onSelect = vi.fn();
		const component = new AgentSwitcherComponent(
			[agent({ id: "agent-1", displayName: "Scout", lifecycle: "running" })],
			undefined,
			onSelect,
			() => {},
		);
		const text = renderedText(component);

		expect(text).toContain("Main thread");
		expect(text).toContain("current");
		expect(text).toContain("Scout");

		component.handleInput("\r");

		expect(onSelect).toHaveBeenCalledWith("main");
	});

	it("selects main when confirming the main thread row", () => {
		const onCancel = vi.fn();
		const onSelect = vi.fn();
		const component = new AgentSwitcherComponent([], undefined, onSelect, onCancel);

		component.handleInput("\r");

		expect(onSelect).toHaveBeenCalledWith("main");
		expect(onCancel).not.toHaveBeenCalled();
	});
});
