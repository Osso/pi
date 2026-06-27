import chalk from "chalk";
import { spawnSync } from "child_process";
import { platform } from "os";

interface ToolConfig {
	name: string;
	binaryName: string;
	systemBinaryNames?: string[];
	termuxPackageName?: string;
}

const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		binaryName: "fd",
		systemBinaryNames: ["fd", "fdfind"],
		termuxPackageName: "fd",
	},
	rg: {
		name: "ripgrep",
		binaryName: "rg",
		termuxPackageName: "ripgrep",
	},
};

function commandExists(cmd: string): boolean {
	try {
		const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
		return result.error === undefined || result.error === null;
	} catch {
		return false;
	}
}

export function getToolPath(tool: "fd" | "rg"): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
	for (const systemBinaryName of systemBinaryNames) {
		if (commandExists(systemBinaryName)) {
			return systemBinaryName;
		}
	}

	return null;
}

export async function ensureTool(tool: "fd" | "rg", silent = false): Promise<string | undefined> {
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	const config = TOOLS[tool];
	if (!config) return undefined;

	if (!silent) {
		const installHint =
			platform() === "android"
				? ` Install with: pkg install ${config.termuxPackageName ?? tool}.`
				: " Install it with your system package manager.";
		console.log(chalk.yellow(`${config.name} not found.${installHint}`));
	}

	return undefined;
}
