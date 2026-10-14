import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnGatedDetachedPayload } from "../../src/core/detached-job-bootstrap.ts";
import { isProcessIdentityAlive, readProcessGroupId, readProcessIdentity } from "../../src/core/runtime-process.ts";
import { readDarwinProcessInfo } from "../../src/core/runtime-process-darwin.ts";

const fixturePath = fileURLToPath(import.meta.url);
const [mode, root] = process.argv.slice(2);

function readSelf() {
	const identity = readProcessIdentity(process.pid);
	assert.equal(isProcessIdentityAlive(identity), true);
	assert.equal(isProcessIdentityAlive({ ...identity, startTimeTicks: identity.startTimeTicks + 1 }), false);
	return {
		identity,
		pgid: readProcessGroupId(process.pid),
		native: process.platform === "darwin" ? readDarwinProcessInfo(process.pid) : null,
		runtime: process.versions.bun ? "bun" : "node",
		version: process.versions.bun ?? process.versions.node,
		platform: process.platform,
		arch: process.arch,
	};
}

async function probeBootstrap(directory: string) {
	const self = readSelf();
	const identityPath = join(directory, "payload.json");
	const markerPath = join(directory, "payload-ran");
	const outputPath = join(directory, "output.log");
	const payload = spawnGatedDetachedPayload({
		command: process.execPath,
		args: [fixturePath, "payload", directory],
		cwd: directory,
		identityPath,
		stdoutPath: outputPath,
		stderrPath: outputPath,
	});
	const exit = payload.waitForExit();
	const killPayload = () => {
		try {
			process.kill(-payload.pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	};
	process.once("SIGTERM", killPayload);
	let exited = false;
	try {
		const identity = readProcessIdentity(payload.pid);
		assert.equal(readProcessGroupId(payload.pid), payload.pid);
		assert.equal(existsSync(markerPath), false);
		assert.equal(existsSync(identityPath), false);
		assert.equal(readFileSync(outputPath, "utf8"), "");
		assert.throws(() => payload.release(), /identity must be persisted before release/);
		payload.persistIdentity();
		const persisted = JSON.parse(readFileSync(identityPath, "utf8"));
		assert.deepEqual(persisted, { ...identity, pgid: payload.pid });
		assert.equal(existsSync(markerPath), false);
		assert.equal(readFileSync(outputPath, "utf8"), "");
		payload.release();
		const outcome = await exit;
		exited = true;
		assert.deepEqual(outcome, { exitCode: 0, signal: null });
		assert.equal(isProcessIdentityAlive(identity), false);
		const marker = JSON.parse(readFileSync(markerPath, "utf8"));
		assert.deepEqual(marker.identity, identity);
		assert.equal(marker.pgid, payload.pid);
		assert.deepEqual(marker.persisted, persisted);
		const output = readFileSync(outputPath, "utf8");
		assert.equal(output, "output\nerror\n");
		return { self, marker, output, outcome };
	} finally {
		process.removeListener("SIGTERM", killPayload);
		if (!exited) {
			killPayload();
			await exit;
		}
	}
}

if (mode === "payload") {
	assert.ok(root, "Expected probe directory");
	const persisted = JSON.parse(readFileSync(join(root, "payload.json"), "utf8"));
	writeFileSync(join(root, "payload-ran"), JSON.stringify({ ...readSelf(), persisted }));
	writeSync(1, "output\n");
	writeSync(2, "error\n");
} else if (mode === "bootstrap") {
	assert.ok(root, "Expected probe directory");
	console.log(JSON.stringify(await probeBootstrap(root)));
} else {
	throw new Error(`Unknown native process probe mode: ${mode}`);
}
