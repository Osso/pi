import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeRuntimePackage, copyClaudeRuntime } from "./claude-runtime.mjs";

const platforms = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64", "windows-arm64"];

for (const platform of platforms) {
	test(`copies the executable and legal notices for ${platform}`, () => {
		const root = mkdtempSync(join(tmpdir(), "pi-claude-runtime-"));
		try {
			const sdkDirectory = join(root, "sdk");
			const nativeDirectory = join(root, "native");
			const destination = join(root, "release");
			mkdirSync(sdkDirectory);
			mkdirSync(nativeDirectory);
			const filename = platform.startsWith("windows-") ? "claude.exe" : "claude";
			writeFileSync(join(nativeDirectory, filename), `executable for ${platform}`);
			writeFileSync(join(sdkDirectory, "LICENSE.md"), "SDK terms");
			writeFileSync(join(nativeDirectory, "LICENSE.md"), "native terms");
			copyClaudeRuntime({ platform, destination, sdkDirectory, nativeDirectory });
			assert.equal(readFileSync(join(destination, "claude", filename), "utf8"), `executable for ${platform}`);
			assert.equal(readFileSync(join(destination, "claude", "SDK-LICENSE.md"), "utf8"), "SDK terms");
			assert.equal(readFileSync(join(destination, "claude", "LICENSE.md"), "utf8"), "native terms");
			assert.equal(claudeRuntimePackage(platform), `@anthropic-ai/claude-agent-sdk-${platform.replace("windows-", "win32-")}`);
			if (!platform.startsWith("windows-") && process.platform !== "win32") {
				assert.equal(statSync(join(destination, "claude", filename)).mode & 0o777, 0o755);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("rejects unsupported platforms before creating a release directory", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-claude-runtime-"));
	try {
		const destination = join(root, "release");
		assert.throws(() => copyClaudeRuntime({ platform: "linux-riscv64", destination }), /Unsupported Claude runtime platform/);
		assert.equal(existsSync(destination), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
