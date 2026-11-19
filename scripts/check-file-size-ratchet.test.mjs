import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = join(import.meta.dirname, "check-file-size-ratchet.mjs");
// Git's default core.quotePath=true quotes non-ASCII paths; user config must not hide that.
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function lines(count) {
	return Array.from({ length: count }, (_, index) => `export const value${index} = ${index};`).join("\n") + "\n";
}

function createRepo(baseline) {
	const root = mkdtempSync(join(tmpdir(), "pi-file-size-ratchet-"));
	execFileSync("git", ["init", "--quiet"], { cwd: root, env });
	mkdirSync(join(root, "scripts"));
	mkdirSync(join(root, "packages", "example", "src"), { recursive: true });
	writeFileSync(join(root, "scripts", "file-size-baseline.json"), `${JSON.stringify(baseline)}\n`);
	return root;
}

function runRatchet(root, ...args) {
	return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", env });
}

test("rejects an oversized source file whose path Git quotes", () => {
	const root = createRepo({});
	try {
		writeFileSync(join(root, "packages", "example", "src", "rendu-écran.ts"), lines(751));
		const result = runRatchet(root);
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout + result.stderr, /rendu-écran\.ts/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("tightens the baseline of a shrunk file whose path Git quotes", () => {
	const path = "packages/example/src/rendu-écran.ts";
	const root = createRepo({ [path]: 801 });
	try {
		writeFileSync(join(root, path), lines(800));
		const result = runRatchet(root, "--tighten");
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const baseline = readFileSync(join(root, "scripts", "file-size-baseline.json"), "utf8");
		assert.deepEqual(JSON.parse(baseline), { [path]: 800 });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
