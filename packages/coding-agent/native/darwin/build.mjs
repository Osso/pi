#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const nativeDir = dirname(fileURLToPath(import.meta.url));
const compilerArchitectures = new Map([
	["arm64", "arm64"],
	["x64", "x86_64"],
]);

function runXcrun(args) {
	const result = spawnSync("xcrun", ["--sdk", "macosx", ...args], { encoding: "utf8" });
	if (result.error || result.status !== 0) {
		const reason = result.error?.message || result.stderr.trim() || `exit ${result.status}`;
		throw new Error(`Darwin native build failed (xcrun ${args.join(" ")}): ${reason}`);
	}
	return result.stdout.trim();
}

function compileArchitecture(arch, sdk) {
	const outputDir = join(nativeDir, "prebuilds", `darwin-${arch}`);
	mkdirSync(outputDir, { recursive: true });
	const temporaryDir = mkdtempSync(join(outputDir, ".build-"));
	const temporaryAddon = join(temporaryDir, "process-info.node");
	try {
		runXcrun([
			"clang",
			"-arch",
			compilerArchitectures.get(arch),
			"-isysroot",
			sdk,
			"-mmacosx-version-min=11.0",
			"-std=c11",
			"-O2",
			"-Wall",
			"-Wextra",
			"-Werror",
			"-bundle",
			"-undefined",
			"dynamic_lookup",
			join(nativeDir, "src", "process-info.c"),
			"-lproc",
			"-o",
			temporaryAddon,
		]);
		renameSync(temporaryAddon, join(outputDir, "process-info.node"));
		console.log(`Built Darwin process prebuild: darwin-${arch}`);
	} finally {
		rmSync(temporaryDir, { recursive: true, force: true });
	}
}

function build(arch = "all") {
	const architectures = arch === "all" ? [...compilerArchitectures.keys()] : [arch];
	for (const architecture of architectures) {
		if (!compilerArchitectures.has(architecture)) throw new Error(`Unsupported Darwin architecture: ${architecture}`);
	}
	if (process.platform !== "darwin") {
		console.log(`Skipping Darwin native compilation on ${process.platform}; no prebuilds produced.`);
		return;
	}
	const sdk = runXcrun(["--show-sdk-path"]);
	if (!sdk) throw new Error("xcrun returned an empty macOS SDK path");
	for (const architecture of architectures) compileArchitecture(architecture, sdk);
}

function requirePrebuild(target) {
	const platform = target === "host" ? `${process.platform}-${process.arch}` : target;
	if (!platform.startsWith("darwin-")) return undefined;
	if (!compilerArchitectures.has(platform.slice("darwin-".length))) {
		throw new Error(`Unsupported Darwin architecture: ${platform}`);
	}
	const source = join(nativeDir, "prebuilds", platform, "process-info.node");
	try {
		if (!statSync(source).isFile()) throw new Error("not a regular file");
	} catch (error) {
		throw new Error(
			`Missing Darwin process prebuild: ${source}. Build on macOS with node native/darwin/build.mjs before packaging.`,
			{ cause: error },
		);
	}
	return { platform, source };
}

function copyPrebuild(target, destination) {
	const asset = requirePrebuild(target);
	if (!asset) return;
	const outputDir = join(resolve(destination), "native", "darwin", "prebuilds", asset.platform);
	mkdirSync(outputDir, { recursive: true });
	copyFileSync(asset.source, join(outputDir, "process-info.node"));
}

function main(args) {
	const [command = "build", ...values] = args;
	if (command === "build" && values.length <= 1) return build(values[0]);
	if (command === "check" && values.length > 0) {
		for (const target of values) requirePrebuild(target);
		return;
	}
	if (command === "copy" && values.length === 2) return copyPrebuild(values[0], values[1]);
	throw new Error(
		"Usage: build.mjs [build [all|arm64|x64] | check <platform...|host> | copy <platform|host> <package-root>]",
	);
}

try {
	main(process.argv.slice(2));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
