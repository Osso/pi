import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { formatExtensionInventory } from "../src/cli/list-extensions.ts";
import { formatToolInventory } from "../src/cli/list-tools.ts";
import type { Extension, ToolInfo } from "../src/core/extensions/types.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("tool inventory", () => {
	it("formats active and inactive tools with their sources", () => {
		const tools: ToolInfo[] = [
			{
				name: "read",
				description: "Read file contents",
				parameters: Type.Object({}),
				sourceInfo: {
					path: "<builtin:read>",
					source: "builtin",
					scope: "temporary",
					origin: "top-level",
				},
			},
			{
				name: "spawn_agent",
				description: "Start a sub-agent",
				parameters: Type.Object({}),
				sourceInfo: {
					path: "/repo/extensions/agents-core.ts",
					source: "extension:agents-core",
					scope: "project",
					origin: "top-level",
				},
			},
		];

		expect(formatToolInventory(tools, ["spawn_agent"])).toBe(
			[
				"Available tools (2)",
				"",
				"active  tool         source                 description",
				"------  -----------  ---------------------  ------------------",
				"no      read         builtin                Read file contents",
				"yes     spawn_agent  extension:agents-core  Start a sub-agent",
			].join("\n"),
		);
	});

	it("keeps default terminal output compact", () => {
		const tools: ToolInfo[] = [
			{
				name: "bash",
				description:
					"Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 10KB.",
				parameters: Type.Object({}),
				sourceInfo: {
					path: "<builtin:bash>",
					source: "builtin",
					scope: "temporary",
					origin: "top-level",
				},
			},
		];

		const output = formatToolInventory(tools, ["bash"]);
		expect(output).toContain("Execute a bash command in the current working direc...");
		expect(output.split("\n").every((line) => line.length <= 100)).toBe(true);
	});

	it("keeps Hostrun out of serialized public package and tool inventory metadata", () => {
		const packageJson = readFileSync(resolve(__dirname, "../../../package.json"), "utf8");
		const packageLockJson = readFileSync(resolve(__dirname, "../../../package-lock.json"), "utf8");
		const publicPackageMetadata = JSON.stringify({ packageJson, packageLockJson });

		expect(publicPackageMetadata).not.toContain("packages/coding-agent/extensions/hostrun");
		expect(publicPackageMetadata).not.toContain("@earendil-works/pi-hostrun-extension");
		expect(publicPackageMetadata).not.toContain("hostrun_eval");
	});

	it("shows an explicit empty state when no tools are available", () => {
		expect(formatToolInventory([], [])).toBe("Available tools: none");
	});

	it("registers /tools as a built-in slash command", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			name: "tools",
			description: "Show available tools",
		});
	});

	it("formats loaded extension inventory with registered resource counts", () => {
		const extension = {
			path: "<first-party:agents-core>",
			resolvedPath: "<first-party:agents-core>",
			sourceInfo: {
				path: "<first-party:agents-core>",
				source: "first-party",
				scope: "temporary",
				origin: "top-level",
			},
			handlers: new Map([["session_start", [async () => undefined]]]),
			tools: new Map([["spawn_agent", {}]]),
			messageRenderers: new Map(),
			commands: new Map([["agents", {}]]),
			flags: new Map(),
			shortcuts: new Map(),
		} as Extension;

		expect(formatExtensionInventory([extension])).toBe(
			[
				"Loaded extensions (1)",
				"",
				"scope    source    extension    commands  tools  handlers",
				"-------  --------  -----------  --------  -----  --------",
				"runtime  built-in  agents-core  1         1      1",
			].join("\n"),
		);
	});

	it("shows an explicit empty state when no extensions are loaded", () => {
		expect(formatExtensionInventory([])).toBe("Loaded extensions: none");
	});

	it("registers /extensions as a built-in slash command", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			name: "extensions",
			description: "Show loaded extensions",
		});
	});
});
