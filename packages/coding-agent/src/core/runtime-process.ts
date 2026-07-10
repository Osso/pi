import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const PI_RUNTIME_ENTRYPOINT_SUFFIXES = [
	"packages/coding-agent/src/cli.ts",
	"packages/coding-agent/src/bun/cli.ts",
	"packages/coding-agent/dist/cli.js",
];

export function isPiRuntimeProcessAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EPERM")) return false;
	}
	const commandLine = tryReadProcessCommandLine(pid);
	return commandLine === undefined || commandLineIsPiRuntime(commandLine);
}

function tryReadProcessCommandLine(pid: number): string[] | undefined {
	try {
		if (process.platform === "linux") {
			return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
		}
		if (process.platform !== "win32") {
			const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
				encoding: "utf8",
				timeout: 1000,
			}).trim();
			return command ? command.split(/\s+/) : undefined;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function commandLineIsPiRuntime(commandLine: string[]): boolean {
	const executable = commandLine[0];
	if (!executable) return false;
	const executableName = basename(executable).toLowerCase();
	if (executableName === "pi" || executableName === "pi.exe") return true;
	return commandLine.slice(1).some((argument) => {
		const normalized = argument.replaceAll("\\", "/");
		return PI_RUNTIME_ENTRYPOINT_SUFFIXES.some(
			(suffix) => normalized === suffix || normalized.endsWith(`/${suffix}`),
		);
	});
}
