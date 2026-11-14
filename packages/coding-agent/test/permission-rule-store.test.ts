import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPermissionPromptHandler,
	type PermissionPromptCaller,
} from "../src/core/permissions/mcp-permission-prompt.ts";
import {
	PermissionRuleStore,
	type WritePermissionRulesOptions,
	writePermissionRules,
} from "../src/core/permissions/rule-store.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("PermissionRuleStore", () => {
	it("matches allow rules by tool name and exact rule content", () => {
		const store = new PermissionRuleStore();

		store.addAllowRules("bash", ["git status"]);

		expect(store.hasAllowRule("bash", "git status")).toBe(true);
		expect(store.hasAllowRule("bash", "git diff")).toBe(false);
		expect(store.hasAllowRule("read", "git status")).toBe(false);
	});

	it("loads persisted allow rules from settings", () => {
		const store = PermissionRuleStore.fromSettings({
			permissionRules: {
				allow: {
					bash: ["git status"],
				},
			},
		});

		expect(store.hasAllowRule("bash", "git status")).toBe(true);
	});
});

describe("writePermissionRules", () => {
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		cwd = join(tmpdir(), `pi-permission-rules-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(cwd, "agent");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2));
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: ["./ext.ts"] }, null, 2));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it.each([
		["userSettings", "agent/settings.json"],
		["projectSettings", ".pi/settings.json"],
		["localSettings", ".pi/settings.local.json"],
	] as const)("writes %s allow rules without dropping existing settings", (destination, relativePath) => {
		writePermissionRules({
			agentDir,
			behavior: "allow",
			cwd,
			destination: destination as WritePermissionRulesOptions["destination"],
			rules: ["git status", "git status"],
			toolName: "bash",
		});

		const settings = JSON.parse(readFileSync(join(cwd, relativePath), "utf-8")) as {
			theme?: string;
			extensions?: string[];
			permissionRules?: { allow?: Record<string, string[]> };
		};
		if (destination === "userSettings") {
			expect(settings.theme).toBe("dark");
		}
		if (destination === "projectSettings") {
			expect(settings.extensions).toEqual(["./ext.ts"]);
		}
		expect(settings.permissionRules?.allow?.bash).toEqual(["git status"]);
	});

	it.each(["userSettings", "projectSettings", "localSettings"] as const)(
		"suppresses matching MCP reviews after reloading %s rules",
		async (destination) => {
			const initialSettings = SettingsManager.create(cwd, agentDir);
			const initialStore = new PermissionRuleStore({
				cwd,
				agentDir,
				settings: initialSettings.getMergedSettings(),
				projectTrusted: true,
			});
			initialStore.applyUpdatedPermissions("bash", [
				{ type: "addRules", destination, behavior: "allow", rules: ["git status"] },
			]);
			expect(initialStore.hasAllowRule("bash", "git status")).toBe(false);

			const reloadedSettings = SettingsManager.create(cwd, agentDir);
			const ruleStore = new PermissionRuleStore({
				cwd,
				agentDir,
				settings: reloadedSettings.getMergedSettings(),
				projectTrusted: true,
			});
			const callTool = vi.fn<PermissionPromptCaller>().mockResolvedValue({ behavior: "allow" });
			const handler = createPermissionPromptHandler({
				cwd,
				permissionPromptTool: "mcp__approval__prompt",
				ruleStore,
				callTool,
			});
			const event = {
				type: "tool_call" as const,
				toolName: "bash",
				toolCallId: "git-status",
				bypassPermissions: false,
				input: { command: "git status" },
			};

			await expect(handler(event)).resolves.toEqual({ block: false });
			expect(callTool).not.toHaveBeenCalled();
			await expect(handler({ ...event, input: { command: "git diff" } })).resolves.toEqual({ block: false });
			expect(callTool).toHaveBeenCalledExactlyOnceWith("mcp__approval__prompt", {
				cwd,
				input: { command: "git diff" },
				tool_name: "bash",
				tool_use_id: "git-status",
			});
		},
	);

	it("adds local rules without replacing merged global and project rules", () => {
		writeFileSync(
			join(cwd, ".pi", "settings.local.json"),
			JSON.stringify({ theme: "light", permissionRules: { allow: { bash: ["git status"] } } }),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ theme: "dark", permissionRules: { allow: { bash: ["git diff"] } } }),
		);
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ permissionRules: { allow: { read: ['{"path":"README.md"}'] } } }),
		);
		const settings = SettingsManager.create(cwd, agentDir);
		const store = new PermissionRuleStore({
			cwd,
			agentDir,
			settings: settings.getMergedSettings(),
			projectTrusted: true,
		});

		expect(store.hasAllowRule("bash", "git status")).toBe(true);
		expect(store.hasAllowRule("bash", "git diff")).toBe(true);
		expect(store.hasAllowRule("read", '{"path":"README.md"}')).toBe(true);
		expect(settings.getMergedSettings().theme).toBe("dark");
	});

	it("does not suppress MCP reviews with local rules from an untrusted project", async () => {
		writeFileSync(
			join(cwd, ".pi", "settings.local.json"),
			JSON.stringify({ permissionRules: { allow: { bash: ["git status"] } } }),
		);
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const ruleStore = new PermissionRuleStore({
			cwd,
			agentDir,
			settings: settings.getMergedSettings(),
			projectTrusted: settings.isProjectTrusted(),
		});
		const callTool = vi.fn<PermissionPromptCaller>().mockResolvedValue({ behavior: "deny", message: "blocked" });
		const handler = createPermissionPromptHandler({
			cwd,
			permissionPromptTool: "mcp__approval__prompt",
			ruleStore,
			callTool,
		});

		await expect(
			handler({
				type: "tool_call",
				toolName: "bash",
				toolCallId: "untrusted-git-status",
				bypassPermissions: false,
				input: { command: "git status" },
			}),
		).resolves.toEqual({ block: true, reason: "blocked" });
		expect(callTool).toHaveBeenCalledExactlyOnceWith("mcp__approval__prompt", {
			cwd,
			input: { command: "git status" },
			tool_name: "bash",
			tool_use_id: "untrusted-git-status",
		});
	});

	it("reports the local settings path when persisted rules contain corrupt JSON", () => {
		const settingsPath = join(cwd, ".pi", "settings.local.json");
		writeFileSync(settingsPath, "{not-valid-json");

		expect(() => new PermissionRuleStore({ cwd, agentDir, projectTrusted: true })).toThrow(
			`Failed to parse settings JSON in ${settingsPath}`,
		);
		expect(readFileSync(settingsPath, "utf-8")).toBe("{not-valid-json");
	});

	it("adds permission rules without reformatting existing settings", () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, '{"theme":"dark","extensions":["./ext.ts"]}\n');

		writePermissionRules({
			agentDir,
			behavior: "allow",
			cwd,
			destination: "userSettings",
			rules: ["git status"],
			toolName: "bash",
		});

		const content = readFileSync(settingsPath, "utf-8");
		expect(content).toContain('"theme":"dark"');
		expect(content).toContain('"extensions":["./ext.ts"]');
		expect(JSON.parse(content).permissionRules.allow.bash).toEqual(["git status"]);
	});

	it("fails with file path context without overwriting corrupt settings JSON", () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, "{not-valid-json");

		expect(() =>
			writePermissionRules({
				agentDir,
				behavior: "allow",
				cwd,
				destination: "userSettings",
				rules: ["git status"],
				toolName: "bash",
			}),
		).toThrow(new RegExp(`Failed to parse settings JSON in ${settingsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		expect(readFileSync(settingsPath, "utf-8")).toBe("{not-valid-json");
	});
});
