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
	if (glob.startsWith("!")) return hasDirectoryPart(rawGlob) ? [] : ["--glob", glob];
	const name = glob.slice(lastTopLevelSlash(glob) + 1);
	// A slash inside a brace group (`pkg/{src/*.ts,test/*.js}`) leaves no single file-name part; matchesGrepGlob filters alone.
	if (name.includes("/")) return [];
	return ["--type-add", `pigrep:${name}`, "--type", "pigrep"];
}

/** A leading "./" anchors the glob to the search directory, as in find: "./*.ts" matches only top-level files. */
function hasDirectoryPart(rawGlob: string): boolean {
	return rawGlob.includes("/");
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
	if (!hasDirectoryPart(rawGlob)) return true;
	const glob = withoutDotSlash(rawGlob);
	const excluded = glob.startsWith("!");
	// nocomment: a leading "#" names a directory such as "#notes", not a comment.
	return minimatch(relativePath, glob.replace(/^!?\/?/, ""), { dot: true, nocomment: true }) !== excluded;
}
