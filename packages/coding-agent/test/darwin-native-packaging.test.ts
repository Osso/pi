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
let root: string;
let native: string;
let compilerLog: string;

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

function invoke(args: string[], platform = "darwin", arch = "arm64") {
	const preload = join(root, "platform.cjs");
	write(
		preload,
		`Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });\nObject.defineProperty(process, "arch", { value: ${JSON.stringify(arch)} });`,
	);
	return spawnSync(process.execPath, ["--require", preload, join(native, "build.mjs"), ...args], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, COMPILER_LOG: compilerLog },
	});
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-darwin-packaging-"));
	native = join(root, "native", "darwin");
	compilerLog = join(root, "compiler.log");
	const source = join(repo, "packages/coding-agent/native/darwin/build.mjs");
	mkdirSync(native, { recursive: true });
	if (existsSync(source)) copyFileSync(source, join(native, "build.mjs"));
	write(join(native, "src/process-info.c"), "fixture source");
	write(
		join(root, "bin/xcrun"),
		`#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.COMPILER_LOG, JSON.stringify(args) + "\\n");
if (args.includes("--show-sdk-path")) { console.log("/fixture/MacOSX.sdk"); process.exit(0); }
if (process.env.FAIL_COMPILER) { console.error("fixture compiler failed"); process.exit(42); }
const value = (flag) => args[args.indexOf(flag) + 1];
const plan = { arch: value("-arch"), sdk: value("-isysroot"), minimum: args.find(a => a.startsWith("-mmacosx-version-min=")), bundle: args.includes("-bundle"), undefined: value("-undefined"), libproc: args.includes("-lproc"), warnings: ["-Wall", "-Wextra", "-Werror"].every(a => args.includes(a)) };
fs.writeFileSync(value("-o"), JSON.stringify(plan));
`,
	);
	// Only the compiler boundary is mocked; the build script and file copies run unchanged.
	chmodSync(join(root, "bin/xcrun"), 0o755);
});

function writeReleaseFixtureFiles(fixture: string, platform: string) {
	const packageDir = join(fixture, "packages/coding-agent");
	const script = join(fixture, "scripts/build-binaries.sh");
	write(script, readFileSync(join(repo, "scripts/build-binaries.sh"), "utf8"));
	chmodSync(script, 0o755);
	write(join(packageDir, "native/darwin/build.mjs"), readFileSync(join(native, "build.mjs"), "utf8"));
	for (const path of [
		"package.json",
		"README.md",
		"CHANGELOG.md",
		"extensions/bwrap/src/fs-worker.cjs",
		"dist/modes/interactive/theme/dark.json",
		"dist/modes/interactive/assets/icon.png",
		"dist/core/export-html/template.html",
		"docs/guide.md",
		"examples/example.ts",
	]) {
		write(join(packageDir, path), "fixture");
	}
	write(join(fixture, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"), "wasm");
	write(join(fixture, "node_modules/@mariozechner/clipboard/index.js"), "clipboard");
	write(join(fixture, `node_modules/@mariozechner/clipboard-${platform}/index.js`), "clipboard-native");
	write(join(fixture, `packages/tui/native/darwin/prebuilds/${platform}/darwin-modifiers.node`), "terminal-addon");
	return { packageDir, script };
}

function writeMockBunExecutable(): void {
	write(
		join(root, "bin/bun"),
		`#!${process.execPath}\nconst fs = require("node:fs");\nconst path = require("node:path");\nfs.appendFileSync(process.env.BUN_LOG, "compile\\n");\nconst output = process.argv[process.argv.indexOf("--outfile") + 1];\nfs.mkdirSync(path.dirname(output), { recursive: true });\nfs.writeFileSync(output, "fixture-binary");`,
	);
	chmodSync(join(root, "bin/bun"), 0o755);
}

function createReleaseFixture(platform: string) {
	const { packageDir, script } = writeReleaseFixtureFiles(join(root, "repo"), platform);
	writeMockBunExecutable();
	const output = join(root, "release-output");
	return {
		packageDir,
		output,
		run: () =>
			spawnSync(script, ["--skip-install", "--skip-deps", "--skip-build", "--platform", platform, "--out", output], {
				encoding: "utf8",
				env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, BUN_LOG: join(root, "bun.log") },
			}),
	};
}

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Darwin release integration", () => {
	it("rejects missing process prebuilds before invoking Bun or replacing output", () => {
		const fixture = createReleaseFixture("darwin-arm64");
		write(join(fixture.output, "keep.txt"), "prior artifact");
		const result = fixture.run();
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Missing Darwin process prebuild");
		expect(existsSync(join(root, "bun.log"))).toBe(false);
		expect(readFileSync(join(fixture.output, "keep.txt"), "utf8")).toBe("prior artifact");
	});

	it.each(["darwin-arm64", "darwin-x64"])("archives %s process and terminal addons at the loader path", (platform) => {
		const fixture = createReleaseFixture(platform);
		write(join(fixture.packageDir, "native/darwin/prebuilds", platform, "process-info.node"), "process-addon");
		const result = fixture.run();
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		const assets = join(fixture.output, platform, "native/darwin/prebuilds", platform);
		expect(readFileSync(join(assets, "process-info.node"), "utf8")).toBe("process-addon");
		expect(readFileSync(join(assets, "darwin-modifiers.node"), "utf8")).toBe("terminal-addon");
		expect(existsSync(join(fixture.output, `pi-${platform}.tar.gz`))).toBe(true);
	});

	it("ships compiler source and available prebuilds in npm packages without lifecycle scripts", () => {
		const packageDir = join(root, "npm-package");
		write(join(packageDir, "package.json"), readFileSync(join(repo, "packages/coding-agent/package.json"), "utf8"));
		for (const file of [
			"build.mjs",
			"src/process-info.c",
			"prebuilds/darwin-arm64/process-info.node",
			"prebuilds/darwin-x64/process-info.node",
		])
			write(join(packageDir, "native/darwin", file), "fixture");
		const result = spawnSync(
			"npm",
			["--prefix", packageDir, "pack", "--dry-run", "--ignore-scripts", "--json", "--workspaces=false"],
			{ cwd: packageDir, encoding: "utf8" },
		);
		expect(result.status).toBe(0);
		const packed = Object.values(JSON.parse(result.stdout) as Record<string, { files: { path: string }[] }>);
		expect(packed, `${result.stdout}\n${result.stderr}`).toHaveLength(1);
		expect(packed[0].files.map((file) => file.path)).toEqual(
			expect.arrayContaining([
				"native/darwin/build.mjs",
				"native/darwin/src/process-info.c",
				"native/darwin/prebuilds/darwin-arm64/process-info.node",
				"native/darwin/prebuilds/darwin-x64/process-info.node",
			]),
		);
	});
});

describe("Darwin native packaging", () => {
	it("builds both supported architectures against an explicit SDK", () => {
		const result = invoke([]);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		for (const [arch, compilerArch] of [
			["arm64", "arm64"],
			["x64", "x86_64"],
		]) {
			const output = join(native, "prebuilds", `darwin-${arch}`, "process-info.node");
			expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
				arch: compilerArch,
				sdk: "/fixture/MacOSX.sdk",
				minimum: "-mmacosx-version-min=11.0",
				bundle: true,
				undefined: "dynamic_lookup",
				libproc: true,
				warnings: true,
			});
		}
	});

	it.each(["linux", "win32"])("skips compilation on %s without producing prebuilds", (platform) => {
		const result = invoke([], platform);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Skipping Darwin");
		expect(existsSync(compilerLog)).toBe(false);
		expect(existsSync(join(native, "prebuilds"))).toBe(false);
	});

	it("can build one architecture explicitly", () => {
		const result = invoke(["build", "x64"]);
		expect(result.status).toBe(0);
		expect(existsSync(join(native, "prebuilds/darwin-x64/process-info.node"))).toBe(true);
		expect(existsSync(join(native, "prebuilds/darwin-arm64/process-info.node"))).toBe(false);
	});

	it("rejects unsupported architectures before invoking the compiler", () => {
		const result = invoke(["build", "ia32"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Unsupported Darwin architecture: ia32");
		expect(existsSync(compilerLog)).toBe(false);
	});

	it("propagates compiler failure without publishing an addon", () => {
		write(
			join(root, "bin/xcrun"),
			`#!${process.execPath}\nif (process.argv.includes("--show-sdk-path")) console.log("/fixture/SDK"); else { console.error("fixture compiler failed"); process.exit(42); }`,
		);
		const result = invoke([]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("fixture compiler failed");
		expect(existsSync(join(native, "prebuilds/darwin-arm64/process-info.node"))).toBe(false);
	});

	it.each(["darwin-arm64", "darwin-x64"])("copies %s to the exact package-root loader path from Linux", (platform) => {
		write(join(native, "prebuilds", platform, "process-info.node"), `fixture-${platform}`);
		const destination = join(root, "release");
		const result = invoke(["copy", platform, destination], "linux");
		expect(result.status).toBe(0);
		expect(readFileSync(join(destination, "native/darwin/prebuilds", platform, "process-info.node"), "utf8")).toBe(
			`fixture-${platform}`,
		);
		expect(existsSync(compilerLog)).toBe(false);
	});

	it("fails a missing cross-Mac prebuild before creating a destination", () => {
		const destination = join(root, "release");
		const result = invoke(["copy", "darwin-arm64", destination], "linux");
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Missing Darwin process prebuild");
		expect(existsSync(destination)).toBe(false);
	});

	it("checks every requested Darwin architecture without compiling", () => {
		write(join(native, "prebuilds/darwin-arm64/process-info.node"), "arm64");
		const result = invoke(["check", "darwin-arm64", "darwin-x64"], "linux");
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("darwin-x64");
		expect(existsSync(compilerLog)).toBe(false);
	});

	it("copies the native host asset for local binary packaging", () => {
		write(join(native, "prebuilds/darwin-x64/process-info.node"), "host-addon");
		const destination = join(root, "dist");
		expect(invoke(["copy", "host", destination], "darwin", "x64").status).toBe(0);
		expect(readFileSync(join(destination, "native/darwin/prebuilds/darwin-x64/process-info.node"), "utf8")).toBe(
			"host-addon",
		);
	});

	it("leaves non-Darwin binary destinations untouched", () => {
		const destination = join(root, "release");
		expect(invoke(["copy", "linux-x64", destination], "linux").status).toBe(0);
		expect(existsSync(destination)).toBe(false);
	});
});
