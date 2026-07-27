import { resolve } from "node:path";
import { spawnProcessSync } from "./child-process.ts";

export function readGitCommonDirectory(cwd: string): string | undefined {
	const result = spawnProcessSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.status !== 0) return undefined;
	const commonDirectory = result.stdout.trim();
	return commonDirectory.length > 0 ? resolve(cwd, commonDirectory) : undefined;
}
