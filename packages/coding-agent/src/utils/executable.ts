import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";

export interface ExecutableAvailabilityOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

const DEFAULT_UNIX_PATH = "/usr/bin:/bin";
const DEFAULT_WINDOWS_EXTENSIONS = ".COM;.EXE;.BAT;.CMD";

export function isExecutableAvailable(command: string, options: ExecutableAvailabilityOptions = {}): boolean {
	if (!command) return false;

	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const commandNames = executableCommandNames(command, env);
	if (isExecutablePath(command)) {
		return commandNames.some((name) => isExecutableFile(resolve(cwd, name)));
	}

	const searchPath = readEnvironmentValue(env, "PATH") ?? (process.platform === "win32" ? "" : DEFAULT_UNIX_PATH);
	return searchPath.split(delimiter).some((directory) => {
		const searchDirectory = directory || cwd;
		return commandNames.some((name) => isExecutableFile(join(searchDirectory, name)));
	});
}

function isExecutablePath(command: string): boolean {
	return isAbsolute(command) || command.includes("/") || (process.platform === "win32" && command.includes("\\"));
}

function executableCommandNames(command: string, env: NodeJS.ProcessEnv): string[] {
	if (process.platform !== "win32" || extname(command)) return [command];
	const pathExtensions = readEnvironmentValue(env, "PATHEXT") ?? DEFAULT_WINDOWS_EXTENSIONS;
	return pathExtensions
		.split(";")
		.filter(Boolean)
		.map((extension) => `${command}${extension}`);
}

function readEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
	return key ? env[key] : undefined;
}

function isExecutableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		if (process.platform !== "win32") accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
