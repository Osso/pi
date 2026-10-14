import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const packages = [
	["ai", "@earendil-works/pi-ai"],
	["agent-core", "@earendil-works/pi-agent-core"],
	["tui", "@earendil-works/pi-tui"],
	["coding-agent", "@earendil-works/pi-coding-agent"],
];
let root: string;
let npmLog: string;

function writeFixture(path: string, contents: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}

function writeAsset(platform: string) {
	writeFixture(
		join(root, "packages/coding-agent/native/darwin/prebuilds", platform, "process-info.node"),
		`test fixture ${platform}; not a native executable`,
	);
}

function runPublication(dryRun: boolean, simulateWindows = false) {
	const preload = join(root, "win32.cjs");
	if (simulateWindows) {
		writeFixture(preload, 'Object.defineProperty(process, "platform", { value: "win32" });');
	}
	return spawnSync(
		process.execPath,
		[
			...(simulateWindows ? ["--require", preload] : []),
			join(root, "scripts/publish.mjs"),
			...(dryRun ? ["--dry-run"] : []),
		],
		{
			cwd: root,
			encoding: "utf8",
			timeout: 10000,
			env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, NPM_LOG: npmLog },
		},
	);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-darwin-npm-publication-"));
	npmLog = join(root, "npm.log");
	for (const [directory, name] of packages) {
		writeFixture(join(root, "packages", directory, "package.json"), JSON.stringify({ name, version: "1.2.3" }));
		mkdirSync(join(root, "packages", directory, "dist"));
	}
	for (const path of ["scripts/publish.mjs", "packages/coding-agent/native/darwin/build.mjs"]) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		copyFileSync(join(repo, path), join(root, path));
	}
	writeFixture(
		join(root, "bin/npm"),
		`#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NPM_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "view") {
	console.error("E404 package not published");
	process.exit(1);
}
if (args[0] === "pack") {
	console.log(JSON.stringify([{ filename: "fixture.tgz", files: [], size: 0, unpackedSize: 0 }]));
	process.exit(0);
}
console.error("Unexpected npm operation: " + args.join(" "));
process.exit(99);
`,
	);
	chmodSync(join(root, "bin/npm"), 0o755);
	copyFileSync(join(root, "bin/npm"), join(root, "bin/npm.cmd"));
	chmodSync(join(root, "bin/npm.cmd"), 0o755);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Darwin npm publication preflight", () => {
	it.each([false, true])("runs the actual Node preflight on simulated Windows (missing asset: %s)", (missingAsset) => {
		writeAsset("darwin-arm64");
		if (!missingAsset) writeAsset("darwin-x64");
		const result = runPublication(true, true);
		expect(result.error).toBeUndefined();
		if (missingAsset) {
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("Missing Darwin process prebuild");
			expect(result.stderr).toContain("darwin-x64");
			expect(existsSync(npmLog)).toBe(false);
			return;
		}
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		const commands = readFileSync(npmLog, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(commands).toEqual(
			packages.flatMap(([, name]) => [
				["view", `${name}@1.2.3`, "version", "--json"],
				["pack", "--dry-run", "--ignore-scripts", "--json"],
			]),
		);
	});

	it.each([false, true])("rejects absent assets before any npm operation (dry run: %s)", (dryRun) => {
		const result = runPublication(dryRun);
		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Missing Darwin process prebuild");
		expect(existsSync(npmLog)).toBe(false);
	});

	it.each(["darwin-arm64", "darwin-x64"])("rejects assets containing only %s before any npm operation", (platform) => {
		writeAsset(platform);
		const missing = platform === "darwin-arm64" ? "darwin-x64" : "darwin-arm64";
		const result = runPublication(true);
		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Missing Darwin process prebuild");
		expect(result.stderr).toContain(missing);
		expect(existsSync(npmLog)).toBe(false);
	});

	it("permits dry-run validation with regular fixture files for both architectures without publishing", () => {
		writeAsset("darwin-arm64");
		writeAsset("darwin-x64");
		const result = runPublication(true);
		expect(result.error).toBeUndefined();
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		const commands = readFileSync(npmLog, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(commands).toEqual(
			packages.flatMap(([, name]) => [
				["view", `${name}@1.2.3`, "version", "--json"],
				["pack", "--dry-run", "--ignore-scripts", "--json"],
			]),
		);
	});
});
