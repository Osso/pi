import { accessSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { normalizePath, resolvePath } from "../../utils/paths.ts";

const NARROW_NO_BREAK_SPACE = "\u202F";

/** Replaces straight apostrophes with U+2019, which macOS uses in screenshot names like "Capture d'écran". */
function curlyQuoteVariant(filePath: string): string {
	return filePath.replace(/'/g, "\u2019");
}

/** macOS filename variants to try, in order, when the literal path does not exist. */
function readPathVariants(resolved: string): string[] {
	// macOS stores filenames in NFD (decomposed) form.
	const nfd = resolved.normalize("NFD");
	return [
		// macOS screenshots put a narrow no-break space before AM/PM.
		resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
		nfd,
		curlyQuoteVariant(resolved),
		curlyQuoteVariant(nfd),
	].filter((variant) => variant !== resolved);
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * fd and rg honor .gitignore only inside git repos unless given --no-require-git.
 * Inside repos, their default git-aware behavior stops parent .gitignore rules at
 * nested repo boundaries: https://github.com/earendil-works/pi/issues/5960
 */
export async function isInsideGitRepo(searchPath: string): Promise<boolean> {
	for (let current = searchPath; ; ) {
		if (await pathExists(path.join(current, ".git"))) return true;
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

export function expandPath(filePath: string): string {
	return normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);
	if (fileExists(resolved)) return resolved;
	return readPathVariants(resolved).find(fileExists) ?? resolved;
}

export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
	const resolved = resolveToCwd(filePath, cwd);
	if (await pathExists(resolved)) return resolved;
	for (const variant of readPathVariants(resolved)) {
		if (await pathExists(variant)) return variant;
	}
	return resolved;
}
