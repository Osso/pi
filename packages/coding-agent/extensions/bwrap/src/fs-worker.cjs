const fs = require("node:fs/promises");
const path = require("node:path");

const [operation, payloadJson] = process.argv.slice(2);
const payload = JSON.parse(payloadJson || "{}");
const workspace = path.resolve(payload.workspace || process.cwd());

function isInsideWorkspace(candidate, workspaceRoot) {
	const relativePath = path.relative(workspaceRoot, candidate);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function nearestExistingParent(targetPath) {
	let current = path.dirname(targetPath);
	while (current !== path.dirname(current)) {
		try {
			return await fs.realpath(current);
		} catch (error) {
			if (!error || error.code !== "ENOENT") throw error;
			current = path.dirname(current);
		}
	}
	return await fs.realpath(current);
}

async function resolveWorkspacePath(value, options = {}) {
	const resolved = path.resolve(value || workspace);
	if (!isInsideWorkspace(resolved, workspace)) throw new Error(`sandbox path escapes workspace: ${value}`);
	const realWorkspace = await fs.realpath(workspace);
	try {
		const realTarget = await fs.realpath(resolved);
		if (isInsideWorkspace(realTarget, realWorkspace)) return resolved;
		throw new Error(`sandbox path symlink escapes workspace: ${value}`);
	} catch (error) {
		if (!options.allowMissing || !error || error.code !== "ENOENT") throw error;
		const realParent = await nearestExistingParent(resolved);
		if (isInsideWorkspace(realParent, realWorkspace)) return resolved;
		throw new Error(`sandbox path parent escapes workspace: ${value}`);
	}
}

async function walk(root, visit) {
	const entries = await fs.readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name === ".git" || entry.name === "node_modules") continue;
		const absolute = path.join(root, entry.name);
		if (entry.isDirectory()) await walk(absolute, visit);
		else await visit(absolute);
	}
}

function matchesGlob(filePath, pattern) {
	const normalized = filePath.split(path.sep).join("/");
	const base = path.basename(normalized);
	if (path.matchesGlob) return path.matchesGlob(normalized, pattern) || path.matchesGlob(base, pattern);
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

async function readFile() {
	return { data: (await fs.readFile(await resolveWorkspacePath(payload.path))).toString("base64") };
}

async function readRange() {
	const handle = await fs.open(await resolveWorkspacePath(payload.path), "r");
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
	await fs.writeFile(await resolveWorkspacePath(payload.path, { allowMissing: true }), payload.content, "utf8");
	return { ok: true };
}

async function mkdir() {
	await fs.mkdir(await resolveWorkspacePath(payload.path, { allowMissing: true }), { recursive: true });
	return { ok: true };
}

async function access() {
	await fs.access(await resolveWorkspacePath(payload.path));
	return { ok: true };
}

async function exists() {
	try {
		await fs.access(await resolveWorkspacePath(payload.path));
		return { exists: true };
	} catch {
		return { exists: false };
	}
}

async function stat() {
	const fileStat = await fs.stat(await resolveWorkspacePath(payload.path));
	return { isDirectory: fileStat.isDirectory(), size: fileStat.size };
}

async function readdir() {
	return { entries: await fs.readdir(await resolveWorkspacePath(payload.path)) };
}

async function find() {
	const results = [];
	const cwd = await resolveWorkspacePath(payload.cwd);
	await walk(cwd, async (absolute) => {
		if (results.length >= payload.limit) return;
		const relativePath = path.relative(cwd, absolute).split(path.sep).join("/");
		if (matchesGlob(relativePath, payload.pattern)) results.push(relativePath);
	});
	return { results };
}

async function collectGrepFiles(rootPath, rootIsDirectory) {
	if (!rootIsDirectory) return [rootPath];
	const files = [];
	await walk(rootPath, async (absolute) => files.push(absolute));
	return files;
}

function appendGrepMatch(linesOut, relativePath, lines, matchIndex, context) {
	let linesTruncated = false;
	const start = context > 0 ? Math.max(0, matchIndex - context) : matchIndex;
	const end = context > 0 ? Math.min(lines.length - 1, matchIndex + context) : matchIndex;
	for (let current = start; current <= end; current += 1) {
		const truncated = truncateLine(lines[current] || "");
		if (truncated.truncated) linesTruncated = true;
		const separator = current === matchIndex ? ":" : "-";
		linesOut.push(`${relativePath}${separator}${current + 1}${separator} ${truncated.text}`);
	}
	return linesTruncated;
}

async function grep() {
	const rootPath = await resolveWorkspacePath(payload.path);
	const rootStat = await fs.stat(rootPath);
	const rootIsDirectory = rootStat.isDirectory();
	const files = await collectGrepFiles(rootPath, rootIsDirectory);
	const matcher = makeMatcher(payload.pattern, payload.literal, payload.ignoreCase);
	const context = Math.max(0, payload.context || 0);
	const limit = Math.max(1, payload.limit || 100);
	const linesOut = [];
	let count = 0;
	let linesTruncated = false;
	for (const file of files) {
		if (count >= limit) break;
		const relativePath = rootIsDirectory ? path.relative(rootPath, file).split(path.sep).join("/") : path.basename(file);
		if (payload.glob && !matchesGlob(relativePath, payload.glob)) continue;
		let lines;
		try {
			lines = (await fs.readFile(file, "utf8")).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
		} catch {
			continue;
		}
		for (let index = 0; index < lines.length; index += 1) {
			if (!matcher(lines[index] || "")) continue;
			count += 1;
			if (appendGrepMatch(linesOut, relativePath, lines, index, context)) linesTruncated = true;
			if (count >= limit) break;
		}
	}
	if (count === 0) return { text: "No matches found" };
	const details = {};
	if (count >= limit) details.matchLimitReached = limit;
	if (linesTruncated) details.linesTruncated = true;
	return { text: linesOut.join("\n"), details };
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
	readText: async () => ({ text: await fs.readFile(resolveWorkspacePath(payload.path), "utf8") }),
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
