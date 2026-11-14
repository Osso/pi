// File-size ratchet for hand-written source files (ts-readability rule: files over 750 lines must be split).
//
//   node scripts/check-file-size-ratchet.mjs                  fail if a file grew past its baseline or a new file is over the limit
//   node scripts/check-file-size-ratchet.mjs --tighten        lower baseline entries to current sizes; drop files now within the limit
//   node scripts/check-file-size-ratchet.mjs --upstream-merge also raise entries, but only for paths that exist in upstream/main
//
// Files that exist only in this fork can never be raised: shrink them instead.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const MAX_LINES = 750;
const BASELINE_PATH = "scripts/file-size-baseline.json";
const UPSTREAM_REF = "upstream/main";

const mode = process.argv[2];
if (mode !== undefined && mode !== "--tighten" && mode !== "--upstream-merge") {
	console.error(`Unknown option: ${mode}`);
	process.exit(2);
}

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function isCheckedSourceFile(path) {
	if (!/\.(ts|tsx|js|mjs|cjs)$/.test(path) || path.endsWith(".d.ts")) return false;
	if (/(^|\/)(test|tests|dist|node_modules|examples)\//.test(path) || /\.(test|spec)\.[a-z]+$/.test(path))
		return false;
	return /^packages\/[^/]+\/src\//.test(path) || path.startsWith("packages/coding-agent/extensions/");
}

function countLines(text) {
	if (text.length === 0) return 0;
	const lines = text.split("\n").length;
	return text.endsWith("\n") ? lines - 1 : lines;
}

function isGenerated(text) {
	return /auto-generated|do not edit/i.test(text.split("\n", 3).join("\n"));
}

function readCurrentSizes() {
	const sizes = new Map();
	// Measure the working tree: include untracked files, skip tracked files deleted from disk.
	const paths = git("ls-files", "--cached", "--others", "--exclude-standard", "packages").split("\n");
	for (const path of paths.filter((path) => isCheckedSourceFile(path) && existsSync(path))) {
		const text = readFileSync(path, "utf8");
		if (!isGenerated(text)) sizes.set(path, countLines(text));
	}
	return sizes;
}

function readUpstreamPaths() {
	return new Set(git("ls-tree", "-r", "--name-only", UPSTREAM_REF).split("\n"));
}

const baseline = new Map(Object.entries(JSON.parse(readFileSync(BASELINE_PATH, "utf8"))));
const current = readCurrentSizes();

if (mode !== undefined) {
	const upstreamPaths = mode === "--upstream-merge" ? readUpstreamPaths() : new Set();
	const next = {};
	for (const [path, lines] of [...current].sort(([a], [b]) => a.localeCompare(b))) {
		if (lines <= MAX_LINES) continue;
		const allowed = baseline.get(path);
		const mayRaise = upstreamPaths.has(path);
		if (allowed === undefined && !mayRaise) continue;
		next[path] = allowed === undefined || mayRaise ? lines : Math.min(lines, allowed);
	}
	writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, "\t")}\n`);
	console.log(`Wrote ${BASELINE_PATH} with ${Object.keys(next).length} files over ${MAX_LINES} lines.`);
}

const failures = [];
const finalBaseline = new Map(Object.entries(JSON.parse(readFileSync(BASELINE_PATH, "utf8"))));
for (const [path, lines] of current) {
	const allowed = finalBaseline.get(path) ?? MAX_LINES;
	if (lines > allowed) {
		failures.push(
			finalBaseline.has(path)
				? `${path}: ${lines} lines, baseline ${allowed}. Do not grow files over ${MAX_LINES} lines; split or shrink it.`
				: `${path}: ${lines} lines, limit ${MAX_LINES}. Split it into modules.`,
		);
	}
}
for (const path of finalBaseline.keys()) {
	if (!current.has(path)) failures.push(`${path}: listed in ${BASELINE_PATH} but missing. Run with --tighten.`);
}

if (failures.length > 0) {
	console.error(`File-size ratchet failed:\n${failures.map((failure) => `  ${failure}`).join("\n")}`);
	process.exit(1);
}
const shrunk = [...finalBaseline].filter(([path, allowed]) => (current.get(path) ?? 0) < allowed).length;
if (shrunk > 0) console.log(`${shrunk} baselined files shrank; run with --tighten to lock in the smaller sizes.`);
