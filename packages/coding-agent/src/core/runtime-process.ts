import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

export interface ProcessIdentity {
	pid: number;
	startTimeTicks: number;
}

const PI_RUNTIME_ENTRYPOINT_SUFFIXES = [
	"packages/coding-agent/src/cli.ts",
	"packages/coding-agent/src/bun/cli.ts",
	"packages/coding-agent/dist/cli.js",
];

function readProcessStat(pid: number): { identity: ProcessIdentity; state: string } {
	if (process.platform !== "linux") throw new Error("Exact process identity requires Linux /proc");
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	const commandEnd = stat.lastIndexOf(")");
	if (commandEnd < 0) throw new Error(`Invalid /proc stat for process ${pid}`);
	const fields = stat
		.slice(commandEnd + 2)
		.trim()
		.split(/\s+/);
	const state = fields[0];
	const startTimeTicks = Number(fields[19]);
	if (!state || !Number.isSafeInteger(startTimeTicks) || startTimeTicks <= 0) {
		throw new Error(`Invalid process stat for process ${pid}`);
	}
	return { identity: { pid, startTimeTicks }, state };
}

export function readProcessIdentity(pid: number): ProcessIdentity {
	return readProcessStat(pid).identity;
}

export function isProcessIdentityAlive(identity: ProcessIdentity): boolean {
	try {
		const processStat = readProcessStat(identity.pid);
		return (
			processStat.identity.startTimeTicks === identity.startTimeTicks &&
			processStat.state !== "Z" &&
			processStat.state !== "X"
		);
	} catch {
		return false;
	}
}

export function isPiRuntimeProcessAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	if (!processExists(pid)) return false;
	const commandLine = tryReadProcessCommandLine(pid);
	return commandLine === undefined || commandLineIsPiRuntime(commandLine);
}

export function isVerifiedPiRuntimeProcess(pid: number): boolean {
	if (pid === process.pid) return true;
	if (!processExists(pid)) return false;
	const commandLine = tryReadProcessCommandLine(pid);
	return commandLine !== undefined && commandLineIsPiRuntime(commandLine);
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
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
