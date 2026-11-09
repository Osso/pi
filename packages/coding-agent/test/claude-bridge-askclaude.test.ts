import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bridge, { __test } from "../extensions/claude-bridge/src/index.ts";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-bridge-askclaude-"));
	mkdirSync(join(root, "agent"));
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
});
afterEach(() => {
	__test.resetSharedSession();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

function registerTools(config: unknown): ToolDefinition[] {
	writeFileSync(join(root, "agent", "claude-bridge.json"), JSON.stringify(config));
	const tools: ToolDefinition[] = [];
	bridge({
		cwd: root,
		events: new EventEmitter(),
		on() {},
		registerProvider() {},
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI);
	return tools;
}

describe("bundled AskClaude", () => {
	it("remains disabled unless explicitly enabled", () => {
		expect(registerTools({})).toEqual([]);
	});

	it("preserves the configured tool name and rejects circular Claude delegation", async () => {
		const tools = registerTools({ askClaude: { enabled: true, name: "ConsultClaude" } });
		expect(tools.map((tool) => tool.name)).toEqual(["ConsultClaude"]);
		const result = await tools[0].execute("fixture-call", { prompt: "fixture question" }, undefined, undefined, {
			model: { baseUrl: "claude-bridge" },
		} as never);
		expect(result.content).toEqual([
			{
				type: "text",
				text: expect.stringContaining("AskClaude cannot be used when the active provider is claude-bridge"),
			},
		]);
		expect(result.details).toEqual({ error: true });
	});
});
