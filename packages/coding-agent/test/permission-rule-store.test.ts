import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	PermissionRuleStore,
	type WritePermissionRulesOptions,
	writePermissionRules,
} from "../src/core/permissions/rule-store.ts";

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
});
