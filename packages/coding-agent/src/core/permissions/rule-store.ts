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
	settings?: { permissionRules?: unknown };
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
		this.addSettingsRules(options.settings);
	}

	static fromSettings(settings: { permissionRules?: unknown }): PermissionRuleStore {
		return new PermissionRuleStore({ settings });
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

	addSettingsRules(settings: { permissionRules?: unknown } | undefined): void {
		const permissionRules = readPermissionRules(settings?.permissionRules);
		for (const [toolName, rules] of Object.entries(permissionRules.allow ?? {})) {
			this.addAllowRules(toolName, rules);
		}
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
	const currentContent = existsSync(settingsPath) ? readFileSync(settingsPath, "utf-8") : undefined;
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
	writeFileSync(settingsPath, updatePermissionRulesContent(currentContent, currentSettings.permissionRules), "utf-8");
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

function updatePermissionRulesContent(currentContent: string | undefined, permissionRules: unknown): string {
	const formattedRules = JSON.stringify(permissionRules, null, 2);
	if (!currentContent) {
		return `${JSON.stringify({ permissionRules }, null, 2)}\n`;
	}

	const propertyRange = findTopLevelPropertyValueRange(currentContent, "permissionRules");
	if (propertyRange) {
		return `${currentContent.slice(0, propertyRange.start)}${formattedRules}${currentContent.slice(propertyRange.end)}`;
	}

	const closingBraceIndex = findFinalObjectBrace(currentContent);
	if (closingBraceIndex === undefined) {
		return `${JSON.stringify({ permissionRules }, null, 2)}\n`;
	}

	const beforeBrace = currentContent.slice(0, closingBraceIndex);
	const afterBrace = currentContent.slice(closingBraceIndex);
	const hasExistingProperties = beforeBrace.trim() !== "{";
	const separator = hasExistingProperties ? "," : "";
	const linePrefix = beforeBrace.includes("\n") ? "\n  " : "";
	const lineSuffix = beforeBrace.includes("\n") ? "\n" : "";
	const compactRules = beforeBrace.includes("\n")
		? formattedRules.replace(/\n/g, "\n  ")
		: JSON.stringify(permissionRules);
	return `${beforeBrace.trimEnd()}${separator}${linePrefix}"permissionRules":${beforeBrace.includes("\n") ? " " : ""}${compactRules}${lineSuffix}${afterBrace}`;
}

function findTopLevelPropertyValueRange(
	content: string,
	propertyName: string,
): { start: number; end: number } | undefined {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < content.length; index++) {
		const char = content[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			const endQuote = findStringEnd(content, index);
			const name = JSON.parse(content.slice(index, endQuote + 1)) as string;
			if (depth === 1 && name === propertyName) {
				const colonIndex = content.indexOf(":", endQuote + 1);
				if (colonIndex === -1) return undefined;
				const start = findNextNonWhitespace(content, colonIndex + 1);
				if (start === undefined) return undefined;
				return { start, end: findJsonValueEnd(content, start) };
			}
			index = endQuote;
			continue;
		}

		if (char === "{") depth++;
		if (char === "}") depth--;
	}

	return undefined;
}

function findFinalObjectBrace(content: string): number | undefined {
	const index = content.lastIndexOf("}");
	return index === -1 ? undefined : index;
}

function findNextNonWhitespace(content: string, start: number): number | undefined {
	for (let index = start; index < content.length; index++) {
		if (!/\s/.test(content[index])) {
			return index;
		}
	}
	return undefined;
}

function findStringEnd(content: string, startQuote: number): number {
	let escaped = false;
	for (let index = startQuote + 1; index < content.length; index++) {
		const char = content[index];
		if (escaped) {
			escaped = false;
		} else if (char === "\\") {
			escaped = true;
		} else if (char === '"') {
			return index;
		}
	}
	return startQuote;
}

function findJsonValueEnd(content: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = start; index < content.length; index++) {
		const char = content[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{" || char === "[") {
			depth++;
			continue;
		}
		if (char === "}" || char === "]") {
			if (depth === 0) return index;
			depth--;
			continue;
		}
		if (char === "," && depth === 0) {
			return index;
		}
	}

	return content.length;
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
