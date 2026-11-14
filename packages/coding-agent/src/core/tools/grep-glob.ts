import { minimatch } from "minimatch";

/**
 * ripgrep's positive --glob rules override ignore files, so they would bring back gitignored files.
 * File types only filter, but they match file names alone. Narrow the walk with a type built from the
 * glob's file-name part; matchesGrepGlob checks any directory part. Exclusion globs stay plain --glob.
 */
export function grepGlobArgs(glob: string): string[] {
	if (glob.startsWith("!")) return ["--glob", glob];
	return ["--type-add", `pigrep:${glob.slice(glob.lastIndexOf("/") + 1)}`, "--type", "pigrep"];
}

/** Check a path relative to the search directory against a glob that has a directory part. */
export function matchesGrepGlob(relativePath: string, glob: string): boolean {
	if (glob.startsWith("!") || !glob.includes("/")) return true;
	return minimatch(relativePath, glob.replace(/^\//, ""), { dot: true });
}
