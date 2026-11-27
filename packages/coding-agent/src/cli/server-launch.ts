import { rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { isBunBinary } from "../config.ts";

/** Arguments before the Pi CLI arguments: none for the compiled binary (its argv[1] is internal), else the runtime flags and source entry point. */
export function workerLaunchPrefix(
	bunBinary = isBunBinary,
	argv = process.argv,
	execArgv = process.execArgv,
): string[] {
	if (bunBinary) return [];
	const entrypoint = argv[1];
	if (!entrypoint) throw new Error("Cannot locate Pi CLI entry point");
	return [...execArgv, entrypoint];
}

/** Remove a socket left by a crashed server so a restart can bind; refuse when a server still answers on it. */
export async function removeStaleSocket(path: string): Promise<void> {
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!stat.isSocket()) throw new Error(`Refusing to replace non-socket at ${path}`);
	const live = await new Promise<boolean>((resolve) => {
		const probe = createConnection(path);
		probe.once("connect", () => {
			probe.destroy();
			resolve(true);
		});
		probe.once("error", () => resolve(false));
	});
	if (live) throw new Error(`A pi server is already running on ${path}`);
	rmSync(path, { force: true });
}
