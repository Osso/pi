#!/usr/bin/env node

import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromAgent = createRequire(join(repoRoot, "packages/coding-agent/package.json"));

export function claudeRuntimePackage(platform) {
	const supported = new Set(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64", "windows-arm64"]);
	if (!supported.has(platform)) throw new Error(`Unsupported Claude runtime platform: ${platform}`);
	return `@anthropic-ai/claude-agent-sdk-${platform.replace("windows-", "win32-")}`;
}

export function locateClaudeRuntime(platform) {
	const sdkDirectory = dirname(requireFromAgent.resolve("@anthropic-ai/claude-agent-sdk"));
	const sdk = JSON.parse(readFileSync(join(sdkDirectory, "package.json"), "utf8"));
	const packageName = claudeRuntimePackage(platform);
	const nativeDirectory = dirname(requireFromAgent.resolve(`${packageName}/package.json`));
	const native = JSON.parse(readFileSync(join(nativeDirectory, "package.json"), "utf8"));
	if (native.version !== sdk.version) {
		throw new Error(`Claude runtime ${packageName}@${native.version} does not match SDK ${sdk.version}`);
	}
	return { sdkDirectory, nativeDirectory };
}

export function copyClaudeRuntime({ platform, destination, sdkDirectory, nativeDirectory }) {
	claudeRuntimePackage(platform);
	const filename = platform.startsWith("windows-") ? "claude.exe" : "claude";
	const target = join(destination, "claude");
	mkdirSync(target, { recursive: true });
	copyFileSync(join(nativeDirectory, filename), join(target, filename));
	if (!platform.startsWith("windows-")) chmodSync(join(target, filename), 0o755);
	copyFileSync(join(sdkDirectory, "LICENSE.md"), join(target, "SDK-LICENSE.md"));
	copyFileSync(join(nativeDirectory, "LICENSE.md"), join(target, "LICENSE.md"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [action, requestedPlatform, destination, ...extra] = process.argv.slice(2);
	if (action !== "copy" || !requestedPlatform || !destination || extra.length > 0) {
		throw new Error("Usage: node scripts/claude-runtime.mjs copy <platform|host> <destination>");
	}
	const hostOS = process.platform === "win32" ? "windows" : process.platform;
	const platform = requestedPlatform === "host" ? `${hostOS}-${process.arch}` : requestedPlatform;
	copyClaudeRuntime({ platform, destination: resolve(destination), ...locateClaudeRuntime(platform) });
}
