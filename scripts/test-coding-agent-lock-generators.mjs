import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const generators = [
	{
		script: "generate-coding-agent-install-lock.mjs",
		output: "packages/coding-agent/install-lock/package-lock.json",
	},
	{
		script: "generate-coding-agent-shrinkwrap.mjs",
		output: "packages/coding-agent/npm-shrinkwrap.json",
	},
];

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function lockEntry(name, version, dependencies = {}, optionalDependencies = {}) {
	return {
		name,
		version,
		resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`,
		integrity: "sha512-fixture",
		...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
		...(Object.keys(optionalDependencies).length > 0 ? { optionalDependencies } : {}),
	};
}

function resolvePackage(packages, packageName, fromPath) {
	let current = fromPath;
	while (current) {
		const candidate = `${current}/node_modules/${packageName}`;
		if (packages[candidate]) return packages[candidate];
		const parent = posix.dirname(current);
		if (parent === "." || parent === current) break;
		current = parent;
	}
	const rootCandidate = `node_modules/${packageName}`;
	if (packages[rootCandidate]) return packages[rootCandidate];
	assert.fail(`Cannot resolve ${packageName} from ${fromPath}: ${Object.keys(packages).join(", ")}`);
}

test("both coding-agent lock generators preserve workspace-specific dependency versions", (context) => {
	const fixture = mkdtempSync(join(tmpdir(), "pi-lock-generator-"));
	context.after(() => rmSync(fixture, { recursive: true, force: true }));

	const scriptDir = join(fixture, "scripts");
	mkdirSync(scriptDir);
	for (const { script } of generators) {
		writeFileSync(join(scriptDir, script), readFileSync(join(repoRoot, "scripts", script)));
	}

	writeJson(join(fixture, "packages/coding-agent/package.json"), {
		name: "@earendil-works/pi-coding-agent",
		version: "1.0.0",
		dependencies: {
			"@earendil-works/pi-ai": "1.0.0",
			"@anthropic-ai/sdk": "0.124.0",
			"@google/genai": "1.52.0",
			protobufjs: "7.6.5",
			"shared-fixture": "1.0.0",
		},
		optionalDependencies: { "platform-fixture": "1.0.0" },
	});
	writeJson(join(fixture, "packages/ai/package.json"), {
		name: "@earendil-works/pi-ai",
		version: "1.0.0",
		dependencies: { "@anthropic-ai/sdk": "0.91.1", "shared-fixture": "1.0.0" },
	});

	const packages = {
		"": { name: "fixture", version: "1.0.0" },
		"packages/coding-agent": {
			name: "@earendil-works/pi-coding-agent",
			version: "1.0.0",
		},
		"packages/ai": { name: "@earendil-works/pi-ai", version: "1.0.0" },
		"packages/coding-agent/node_modules/@anthropic-ai/sdk": lockEntry(
			"@anthropic-ai/sdk",
			"0.124.0",
			{ nested: "1.0.0" },
		),
		"packages/coding-agent/node_modules/@google/genai": {
			...lockEntry("@google/genai", "1.52.0"),
			hasInstallScript: true,
		},
		"packages/coding-agent/node_modules/protobufjs": {
			...lockEntry("protobufjs", "7.6.5"),
			hasInstallScript: true,
		},
		"packages/coding-agent/node_modules/@anthropic-ai/sdk/node_modules/nested": lockEntry("nested", "1.0.0"),
		"packages/ai/node_modules/@anthropic-ai/sdk": lockEntry(
			"@anthropic-ai/sdk",
			"0.91.1",
			{ nested: "2.0.0" },
		),
		"packages/ai/node_modules/@anthropic-ai/sdk/node_modules/nested": lockEntry("nested", "2.0.0"),
		"node_modules/shared-fixture": lockEntry("shared-fixture", "1.0.0", { "shared-leaf": "1.0.0" }),
		"node_modules/shared-fixture/node_modules/shared-leaf": lockEntry("shared-leaf", "1.0.0"),
		"node_modules/platform-fixture": {
			...lockEntry("platform-fixture", "1.0.0"),
			os: ["linux"],
		},
	};
	writeJson(join(fixture, "package-lock.json"), { lockfileVersion: 3, packages });

	for (const { script, output } of generators) {
		execFileSync(process.execPath, [join(scriptDir, script)], { cwd: fixture, stdio: "pipe" });
		const generated = JSON.parse(readFileSync(join(fixture, output), "utf8"));
		const lockPackages = generated.packages;
		const isInstallLock = script.includes("install-lock");
		const codingAgent = isInstallLock ? "node_modules/@earendil-works/pi-coding-agent" : "";
		const ai = `${codingAgent ? `${codingAgent}/` : ""}node_modules/@earendil-works/pi-ai`;

		assert.equal(resolvePackage(lockPackages, "@anthropic-ai/sdk", codingAgent).version, "0.124.0");
		assert.equal(resolvePackage(lockPackages, "@anthropic-ai/sdk", ai).version, "0.91.1");
		const codingAgentSdk = `${codingAgent ? `${codingAgent}/` : ""}node_modules/@anthropic-ai/sdk`;
		assert.equal(resolvePackage(lockPackages, "nested", codingAgentSdk).version, "1.0.0");
		assert.equal(
			resolvePackage(lockPackages, "nested", `${ai}/node_modules/@anthropic-ai/sdk`).version,
			"2.0.0",
		);
		assert.equal(resolvePackage(lockPackages, "platform-fixture", codingAgent).version, "1.0.0");
		const sharedFromCodingAgent = resolvePackage(lockPackages, "shared-fixture", codingAgent);
		const sharedFromAi = resolvePackage(lockPackages, "shared-fixture", ai);
		assert.equal(sharedFromCodingAgent.version, "1.0.0");
		assert.equal(sharedFromAi.version, "1.0.0");
		assert.strictEqual(sharedFromCodingAgent, sharedFromAi);
		assert.equal(resolvePackage(lockPackages, "shared-leaf", "node_modules/shared-fixture").version, "1.0.0");
		assert.deepEqual(
			Object.keys(lockPackages).filter((path) => path.includes("node_modules/shared-fixture")),
			["node_modules/shared-fixture", "node_modules/shared-fixture/node_modules/shared-leaf"],
		);
	}
});
