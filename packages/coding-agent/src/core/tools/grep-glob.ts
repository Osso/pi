import { minimatch } from "minimatch";

/**
 * ripgrep's positive --glob rules override ignore files, so they would bring back gitignored files.
 * File types only filter, but they match file names alone. Narrow the walk with a type built from the
 * glob's file-name part; matchesGrepGlob checks any directory part. Exclusion globs stay plain --glob.
 */
export function grepGlobArgs(glob: string): string[] {
	if (glob.startsWith("!")) return ["--glob", glob];
	const nameStart = lastTopLevelSlash(glob) + 1;
	// A slash inside a brace group (`{src/*.ts,test/*.js}`) leaves no single file-name part; matchesGrepGlob filters alone.
	if (nameStart === 0 && glob.includes("/")) return [];
	return ["--type-add", `pigrep:${glob.slice(nameStart)}`, "--type", "pigrep"];
}

function lastTopLevelSlash(glob: string): number {
	let depth = 0;
	let last = -1;
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index];
		if (char === "\\") index++;
		else if (char === "{") depth++;
		else if (char === "}") depth = Math.max(0, depth - 1);
		else if (char === "/" && depth === 0) last = index;
	}
	return last;
}

/** Check a path relative to the search directory against a glob that has a directory part. */
export function matchesGrepGlob(relativePath: string, glob: string): boolean {
	if (glob.startsWith("!") || !glob.includes("/")) return true;
	return minimatch(relativePath, glob.replace(/^\//, ""), { dot: true });
}
