import { readFileSync } from "node:fs";

export interface RunnerInvocation {
	executable: string;
	args: string[];
}

/** Environment `systemd-run --user` needs to reach the user manager. */
const USER_BUS_ENV_KEYS = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const;

/** The unified-hierarchy cgroup of this process, or "" where /proc is unavailable (macOS). */
export function readOwnCgroup(): string {
	try {
		return readFileSync("/proc/self/cgroup", "utf8");
	} catch {
		return "";
	}
}

/**
 * A systemd user service such as `pi-server.service` stops every process in its cgroup, so detached
 * runners started there die on each service restart. Running them through `systemd-run --user --scope`
 * moves them into their own scope; the scope execs the runner, so its PID stays the returned child PID.
 */
export function runnerInvocationOutsideService(invocation: RunnerInvocation, cgroup: string): RunnerInvocation {
	if (!isUserServiceCgroup(cgroup)) return invocation;
	return {
		executable: "systemd-run",
		args: ["--user", "--scope", "--quiet", "--collect", "--", invocation.executable, ...invocation.args],
	};
}

/** Adds the user-bus variables that `systemd-run --user` needs when the runner env is otherwise minimal. */
export function runnerEnvOutsideService(
	env: NodeJS.ProcessEnv,
	cgroup: string,
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	if (!isUserServiceCgroup(cgroup)) return env;
	const busEnv: NodeJS.ProcessEnv = {};
	for (const key of USER_BUS_ENV_KEYS) if (source[key] !== undefined) busEnv[key] = source[key];
	return { ...busEnv, ...env };
}

function isUserServiceCgroup(cgroup: string): boolean {
	const path = cgroup
		.split("\n")
		.find((line) => line.startsWith("0::"))
		?.slice(3)
		.trim();
	return path !== undefined && /\/user@\d+\.service\/.+\.service$/.test(path);
}
