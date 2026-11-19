import { minimatch } from "minimatch";

/**
 * ripgrep's positive --glob rules override ignore files, so they would bring back gitignored files.
 * File types only filter, but they match file names alone. Narrow the walk with a type built from the
 * glob's file-name part; matchesGrepGlob checks any directory part. ripgrep matches --glob against paths
 * relative to its own cwd, not the search directory, so only file-name exclusions stay plain --glob;
 * matchesGrepGlob applies exclusions with a directory part.
 */
export function grepGlobArgs(rawGlob: string): string[] {
	const glob = withoutDotSlash(rawGlob);
	if (glob.startsWith("!")) return glob.includes("/") ? [] : ["--glob", glob];
	const nameStart = lastTopLevelSlash(glob) + 1;
	// A slash inside a brace group (`{src/*.ts,test/*.js}`) leaves no single file-name part; matchesGrepGlob filters alone.
	if (nameStart === 0 && glob.includes("/")) return [];
	return ["--type-add", `pigrep:${glob.slice(nameStart)}`, "--type", "pigrep"];
}

/** A leading "./" names the search directory, as in find: "./src/*.ts" means "src/*.ts". ripgrep never matches it. */
function withoutDotSlash(glob: string): string {
	return glob.replace(/^(!?)(?:\.\/)+/, "$1");
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

/** Check a path relative to the search directory against a glob, or "!" exclusion, that has a directory part. */
export function matchesGrepGlob(relativePath: string, rawGlob: string): boolean {
	const glob = withoutDotSlash(rawGlob);
	if (!glob.includes("/")) return true;
	const excluded = glob.startsWith("!");
	return minimatch(relativePath, glob.replace(/^!?\/?/, ""), { dot: true }) !== excluded;
}
