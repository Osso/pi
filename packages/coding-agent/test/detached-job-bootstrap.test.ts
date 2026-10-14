import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { spawnGatedDetachedPayload } from "../src/core/detached-job-bootstrap.ts";
import { createDetachedJobArtifacts } from "../src/core/detached-job-runner.ts";
import { isProcessIdentityAlive, readProcessGroupId, readProcessIdentity } from "../src/core/runtime-process.ts";

const temporaryDirectories: string[] = [];
const supportsExactIdentity = process.platform === "linux" || process.platform === "darwin";
const probePath = fileURLToPath(new URL("./fixtures/native-process-probe.ts", import.meta.url));

function killPayloadGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("detached job payload bootstrap", () => {
	it.runIf(supportsExactIdentity)(
		"persists payload identity before releasing user code with direct artifact file descriptors",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "pi-detached-bootstrap-"));
			temporaryDirectories.push(root);
			const artifacts = createDetachedJobArtifacts(root, "job-1");
			const markerPath = join(artifacts.directory, "payload-ran");
			const identityPath = join(artifacts.directory, "payload.json");
			const payload = spawnGatedDetachedPayload({
				args: [probePath, "payload", artifacts.directory],
				command: process.execPath,
				cwd: root,
				identityPath,
				stderrPath: artifacts.outputPath,
				stdoutPath: artifacts.outputPath,
			});

			const exit = payload.waitForExit();
			let exited = false;
			try {
				const identity = readProcessIdentity(payload.pid);
				expect(readProcessGroupId(payload.pid)).toBe(payload.pid);
				expect(isProcessIdentityAlive(identity)).toBe(true);
				expect(existsSync(markerPath)).toBe(false);
				expect(existsSync(identityPath)).toBe(false);
				expect(readFileSync(artifacts.outputPath, "utf8")).toBe("");
				if (process.platform === "linux") {
					expect(readlinkSync(`/proc/${payload.pid}/fd/1`)).toBe(artifacts.outputPath);
					expect(readlinkSync(`/proc/${payload.pid}/fd/2`)).toBe(artifacts.outputPath);
					expect(readFileSync(`/proc/${payload.pid}/status`, "utf8")).toContain(`PPid:\t${process.pid}`);
				}

				expect(() => payload.release()).toThrow("identity must be persisted before release");
				payload.persistIdentity();
				const persisted = JSON.parse(readFileSync(identityPath, "utf8"));
				expect(persisted).toEqual({ ...identity, pgid: payload.pid });
				expect(existsSync(markerPath)).toBe(false);
				expect(readFileSync(artifacts.outputPath, "utf8")).toBe("");
				payload.release();
				const outcome = await exit;
				exited = true;
				expect(outcome).toEqual({ exitCode: 0, signal: null });
				const marker = JSON.parse(readFileSync(markerPath, "utf8"));
				expect(marker.identity).toEqual(identity);
				expect(marker.persisted).toEqual(persisted);
				expect(marker.pgid).toBe(payload.pid);
				expect(readFileSync(artifacts.outputPath, "utf8")).toBe("output\nerror\n");
				expect(isProcessIdentityAlive(identity)).toBe(false);
			} finally {
				if (!exited) {
					killPayloadGroup(payload.pid);
					await exit;
				}
			}
		},
	);

	it.runIf(supportsExactIdentity)(
		"loads the real identity adapter and bootstraps a detached payload in Bun",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "pi-bun-bootstrap-"));
			temporaryDirectories.push(root);
			const { stdout, stderr } = await promisify(execFile)("bun", [probePath, "bootstrap", root], {
				timeout: 20_000,
			});
			expect(stderr).toBe("");
			const report = JSON.parse(stdout);
			expect(report).toMatchObject({
				self: { runtime: "bun", platform: process.platform, arch: process.arch },
				marker: { runtime: "bun", platform: process.platform, arch: process.arch },
				output: "output\nerror\n",
				outcome: { exitCode: 0, signal: null },
			});
			if (process.platform === "darwin") {
				expect(report.self.native).toMatchObject({
					...report.self.identity,
					processGroupId: report.self.pgid,
					state: "R",
				});
				expect(report.marker.native).toMatchObject({
					...report.marker.identity,
					processGroupId: report.marker.pgid,
					state: "R",
				});
			}
		},
	);
});
