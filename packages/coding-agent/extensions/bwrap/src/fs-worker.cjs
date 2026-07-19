const fs = require("node:fs/promises");
const path = require("node:path");

const EXPECTED_GREP_READ_ERROR_CODES = new Set(["EACCES", "EISDIR", "ENOENT", "ENOTDIR", "EPERM"]);
const [operation, payloadJson] = process.argv.slice(2);
const payload = JSON.parse(payloadJson || "{}");
const workspace = path.resolve(payload.workspace || process.cwd());

function readErrorCode(error) {
	if (!error || typeof error !== "object") return undefined;
	if (!("code" in error)) return undefined;
	return error.code;
}

function isMissingPathError(error) {
	return readErrorCode(error) === "ENOENT";
}

function isExpectedGrepReadError(error) {
	const code = readErrorCode(error);
	if (!code) return false;
	return EXPECTED_GREP_READ_ERROR_CODES.has(code);
}

function isInsideWorkspace(candidate, workspaceRoot) {
	const relativePath = path.relative(workspaceRoot, candidate);
	if (relativePath === "") return true;
	if (relativePath.startsWith("..")) return false;
	return !path.isAbsolute(relativePath);
}

async function readNearestExistingRealPath(targetPath) {
	let current = path.dirname(targetPath);
	while (current !== path.dirname(current)) {
		try {
			return await fs.realpath(current);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			current = path.dirname(current);
		}
	}
	return fs.realpath(current);
}

async function resolveWorkspacePathWithFilesystemChecks(value, options = {}) {
	const resolved = path.resolve(value || workspace);
	if (!isInsideWorkspace(resolved, workspace)) throw new Error(`sandbox path escapes workspace: ${value}`);
	const realWorkspace = await fs.realpath(workspace);
	try {
		const realTarget = await fs.realpath(resolved);
		if (isInsideWorkspace(realTarget, realWorkspace)) return resolved;
		throw new Error(`sandbox path symlink escapes workspace: ${value}`);
	} catch (error) {
		if (!options.allowMissing) throw error;
		if (!isMissingPathError(error)) throw error;
		const realParent = await readNearestExistingRealPath(resolved);
		if (isInsideWorkspace(realParent, realWorkspace)) return resolved;
		throw new Error(`sandbox path parent escapes workspace: ${value}`);
	}
}

async function readFilesRecursively(root) {
	const entries = await fs.readdir(root, { withFileTypes: true });
	const visibleEntries = entries.filter((entry) => entry.name !== ".git" && entry.name !== "node_modules");
	const fileGroups = await Promise.all(
		visibleEntries.map(async (entry) => {
			const absolutePath = path.join(root, entry.name);
			if (entry.isDirectory()) return readFilesRecursively(absolutePath);
			return [absolutePath];
		}),
	);
	return fileGroups.flat();
}

function matchesGlob(filePath, pattern) {
	const normalized = filePath.split(path.sep).join("/");
	const base = path.basename(normalized);
	if (typeof path.matchesGlob === "function") {
		if (path.matchesGlob(normalized, pattern)) return true;
		return path.matchesGlob(base, pattern);
	}
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) return base.endsWith(pattern.slice(1));
	return normalized.includes(pattern.replaceAll("*", ""));
}

function makeMatcher(pattern, literal, ignoreCase) {
	if (literal) {
		const needle = ignoreCase ? pattern.toLowerCase() : pattern;
		return (line) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
	}
	const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
	return (line) => regex.test(line);
}

function truncateLine(line) {
	if (line.length <= 500) return { text: line, truncated: false };
	return { text: line.slice(0, 500), truncated: true };
}

function limitResults(results, requestedLimit) {
	if (requestedLimit === undefined) return results;
	const numericLimit = Number(requestedLimit);
	if (Number.isNaN(numericLimit)) return results;
	return results.slice(0, Math.max(0, numericLimit));
}

async function readFile() {
	const filePath = await resolveWorkspacePathWithFilesystemChecks(payload.path);
	const content = await fs.readFile(filePath);
	return { data: content.toString("base64") };
}

async function readRange() {
	const filePath = await resolveWorkspacePathWithFilesystemChecks(payload.path);
	const handle = await fs.open(filePath, "r");
	try {
		const length = Math.max(0, payload.end - payload.start);
		const buffer = Buffer.alloc(length);
		const result = await handle.read(buffer, 0, length, payload.start);
		return { data: buffer.subarray(0, result.bytesRead).toString("base64") };
	} finally {
		await handle.close();
	}
}

async function writeFile() {
	const filePath = await resolveWorkspacePathWithFilesystemChecks(payload.path, { allowMissing: true });
	await fs.writeFile(filePath, payload.content, "utf8");
	return { ok: true };
}

async function mkdir() {
	const directoryPath = await resolveWorkspacePathWithFilesystemChecks(payload.path, { allowMissing: true });
	await fs.mkdir(directoryPath, { recursive: true });
	return { ok: true };
}

async function access() {
	const filePath = await resolveWorkspacePathWithFilesystemChecks(payload.path);
	await fs.access(filePath);
	return { ok: true };
}

async function exists() {
	try {
		const filePath = await resolveWorkspacePathWithFilesystemChecks(payload.path);
		await fs.access(filePath);
		return { exists: true };
	} catch {
		return { exists: false };
	}
}

async function stat() {
	const filePath = await resolveWorkspacePathWithFilesystemChecks(payload.path);
	const fileStat = await fs.stat(filePath);
	return { isDirectory: fileStat.isDirectory(), size: fileStat.size };
}

async function readdir() {
	const directoryPath = await resolveWorkspacePathWithFilesystemChecks(payload.path);
	const entries = await fs.readdir(directoryPath);
	return { entries };
}

async function find() {
	const cwd = await resolveWorkspacePathWithFilesystemChecks(payload.cwd);
	const filePaths = await readFilesRecursively(cwd);
	const matchingPaths = filePaths
		.map((absolutePath) => path.relative(cwd, absolutePath).split(path.sep).join("/"))
		.filter((relativePath) => matchesGlob(relativePath, payload.pattern));
	return { results: limitResults(matchingPaths, payload.limit) };
}

function normalizeGrepLines(content) {
	return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

async function readGrepLines(filePath) {
	try {
		const content = await fs.readFile(filePath, "utf8");
		return normalizeGrepLines(content);
	} catch (error) {
		if (isExpectedGrepReadError(error)) return null;
		throw error;
	}
}

function formatGrepMatch({ relativePath, lines, matchIndex, context }) {
	const start = context > 0 ? Math.max(0, matchIndex - context) : matchIndex;
	const end = context > 0 ? Math.min(lines.length - 1, matchIndex + context) : matchIndex;
	const renderedLines = Array.from({ length: end - start + 1 }, (_value, offset) => {
		const current = start + offset;
		const truncatedLine = truncateLine(lines[current] || "");
		const separator = current === matchIndex ? ":" : "-";
		return {
			text: `${relativePath}${separator}${current + 1}${separator} ${truncatedLine.text}`,
			truncated: truncatedLine.truncated,
		};
	});
	return {
		text: renderedLines.map(({ text }) => text).join("\n"),
		linesTruncated: renderedLines.some(({ truncated }) => truncated),
	};
}

function formatGrepFile({ filePath, rootPath, rootIsDirectory, lines, matcher, context, limit }) {
	const relativePath = rootIsDirectory ? path.relative(rootPath, filePath).split(path.sep).join("/") : path.basename(filePath);
	const matchIndexes = lines
		.flatMap((line, index) => (matcher(line || "") ? [index] : []))
		.slice(0, limit);
	const formattedMatches = matchIndexes.map((matchIndex) => formatGrepMatch({ relativePath, lines, matchIndex, context }));
	return {
		count: matchIndexes.length,
		linesTruncated: formattedMatches.some(({ linesTruncated }) => linesTruncated),
		text: formattedMatches.map(({ text }) => text).join("\n"),
	};
}

function relativeGrepPath(filePath, options) {
	if (!options.rootIsDirectory) return path.basename(filePath);
	return path.relative(options.rootPath, filePath).split(path.sep).join("/");
}

async function readGrepFileResult(filePath, options, remainingLimit) {
	const lines = await readGrepLines(filePath);
	if (lines === null) return null;
	return formatGrepFile({
		context: options.context,
		filePath,
		lines,
		limit: remainingLimit,
		matcher: options.matcher,
		rootIsDirectory: options.rootIsDirectory,
		rootPath: options.rootPath,
	});
}

async function collectGrepResults(files, options, fileIndex = 0, matchCount = 0) {
	const searchComplete = fileIndex >= files.length || matchCount >= options.limit;
	if (searchComplete) return { count: matchCount, linesTruncated: false, textParts: [] };

	const filePath = files[fileIndex];
	const relativePath = relativeGrepPath(filePath, options);
	if (options.glob && !matchesGlob(relativePath, options.glob)) {
		return collectGrepResults(files, options, fileIndex + 1, matchCount);
	}

	const remainingLimit = options.limit - matchCount;
	const fileResult = await readGrepFileResult(filePath, options, remainingLimit);
	if (fileResult === null) return collectGrepResults(files, options, fileIndex + 1, matchCount);
	const remainingResults = await collectGrepResults(files, options, fileIndex + 1, matchCount + fileResult.count);
	const textParts = fileResult.text ? [fileResult.text, ...remainingResults.textParts] : remainingResults.textParts;
	return {
		count: remainingResults.count,
		linesTruncated: fileResult.linesTruncated || remainingResults.linesTruncated,
		textParts,
	};
}

async function grep() {
	const rootPath = await resolveWorkspacePathWithFilesystemChecks(payload.path);
	const rootStat = await fs.stat(rootPath);
	const rootIsDirectory = rootStat.isDirectory();
	const files = rootIsDirectory ? await readFilesRecursively(rootPath) : [rootPath];
	const options = {
		context: Math.max(0, payload.context || 0),
		glob: payload.glob,
		limit: Math.max(1, payload.limit || 100),
		matcher: makeMatcher(payload.pattern, payload.literal, payload.ignoreCase),
		rootIsDirectory,
		rootPath,
	};
	const result = await collectGrepResults(files, options);
	if (result.count === 0) return { text: "No matches found" };
	const details = {};
	if (result.count >= options.limit) details.matchLimitReached = options.limit;
	if (result.linesTruncated) details.linesTruncated = true;
	return { text: result.textParts.join("\n"), details };
}

async function readTextFile() {
	return { text: await fs.readFile(resolveWorkspacePathWithFilesystemChecks(payload.path), "utf8") };
}

const operations = {
	access,
	exists,
	find,
	grep,
	mkdir,
	readdir,
	readFile,
	readRange,
	readText: readTextFile,
	stat,
	writeFile,
};

async function main() {
	const handler = operations[operation];
	if (!handler) throw new Error(`unknown op: ${operation}`);
	return handler();
}

main()
	.then((value) => process.stdout.write(JSON.stringify(value)))
	.catch((error) => {
		process.stderr.write(error && error.stack ? error.stack : String(error));
		process.exit(1);
	});
