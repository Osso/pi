import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";

export type PermissionRuleDestination = "session" | "userSettings" | "projectSettings" | "localSettings";
export type PermissionRuleBehavior = "allow";

export type PermissionRuleUpdate = {
	type: "addRules";
	destination: PermissionRuleDestination;
	behavior: PermissionRuleBehavior;
	rules: string[];
};

export type WritePermissionRulesOptions = {
	cwd: string;
	agentDir: string;
	destination: Exclude<PermissionRuleDestination, "session">;
	behavior: PermissionRuleBehavior;
	toolName: string;
	rules: string[];
};

export type PermissionRuleWriter = (options: WritePermissionRulesOptions) => void;

export type PermissionRuleStoreOptions = {
	cwd?: string;
	agentDir?: string;
	writer?: PermissionRuleWriter;
};

type PermissionRulesSettings = {
	allow?: Record<string, string[]>;
};

export class PermissionRuleStore {
	private allowRules = new Map<string, Set<string>>();
	private cwd: string | undefined;
	private agentDir: string | undefined;
	private writer: PermissionRuleWriter;

	constructor(options: PermissionRuleStoreOptions = {}) {
		this.cwd = options.cwd;
		this.agentDir = options.agentDir;
		this.writer = options.writer ?? writePermissionRules;
	}

	hasAllowRule(toolName: string, ruleContent: string): boolean {
		return this.allowRules.get(toolName)?.has(ruleContent) ?? false;
	}

	addAllowRules(toolName: string, rules: string[]): void {
		const ruleSet = this.allowRules.get(toolName) ?? new Set<string>();
		for (const rule of rules) {
			ruleSet.add(rule);
		}
		this.allowRules.set(toolName, ruleSet);
	}

	applyUpdatedPermissions(toolName: string, updates: PermissionRuleUpdate[] | undefined): void {
		for (const update of updates ?? []) {
			if (update.destination === "session") {
				this.addAllowRules(toolName, update.rules);
				continue;
			}

			if (!this.cwd || !this.agentDir) {
				continue;
			}

			this.writer({
				agentDir: this.agentDir,
				behavior: update.behavior,
				cwd: this.cwd,
				destination: update.destination,
				rules: update.rules,
				toolName,
			});
		}
	}
}

export function buildPermissionRuleContent(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "bash" && typeof input.command === "string") {
		return input.command;
	}
	return JSON.stringify(input);
}

export function writePermissionRules(options: WritePermissionRulesOptions): void {
	const settingsPath = resolveSettingsPath(options);
	const currentSettings = readSettings(settingsPath);
	const permissionRules = readPermissionRules(currentSettings.permissionRules);
	const behaviorRules = permissionRules[options.behavior] ?? {};
	const existingRules = behaviorRules[options.toolName] ?? [];
	const nextRules = [...new Set([...existingRules, ...options.rules])];

	currentSettings.permissionRules = {
		...permissionRules,
		[options.behavior]: {
			...behaviorRules,
			[options.toolName]: nextRules,
		},
	};

	mkdirSync(dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(currentSettings, null, 2)}\n`, "utf-8");
}

function resolveSettingsPath(options: WritePermissionRulesOptions): string {
	if (options.destination === "userSettings") {
		return join(options.agentDir, "settings.json");
	}
	if (options.destination === "projectSettings") {
		return join(options.cwd, CONFIG_DIR_NAME, "settings.json");
	}
	return join(options.cwd, CONFIG_DIR_NAME, "settings.local.json");
}

function readSettings(settingsPath: string): Record<string, unknown> & { permissionRules?: unknown } {
	if (!existsSync(settingsPath)) {
		return {};
	}

	const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
	return isRecord(parsed) ? parsed : {};
}

function readPermissionRules(value: unknown): PermissionRulesSettings {
	if (!isRecord(value)) {
		return {};
	}

	const allow = value.allow;
	if (!isRecord(allow)) {
		return {};
	}

	const allowRules: Record<string, string[]> = {};
	for (const [toolName, rules] of Object.entries(allow)) {
		if (Array.isArray(rules)) {
			allowRules[toolName] = rules.filter((rule): rule is string => typeof rule === "string");
		}
	}

	return { allow: allowRules };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
