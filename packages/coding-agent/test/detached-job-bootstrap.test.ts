import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnGatedDetachedPayload } from "../src/core/detached-job-bootstrap.ts";
import { createDetachedJobArtifacts } from "../src/core/detached-job-runner.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("detached job payload bootstrap", () => {
	it("persists payload identity before releasing user code with direct artifact file descriptors", async () => {
		if (process.platform !== "linux") return;
		const root = mkdtempSync(join(tmpdir(), "pi-detached-bootstrap-"));
		temporaryDirectories.push(root);
		const artifacts = createDetachedJobArtifacts(root, "job-1");
		const markerPath = join(root, "payload-ran");
		const identityPath = join(artifacts.directory, "payload.json");
		const payload = spawnGatedDetachedPayload({
			args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran"); console.log("output")`],
			command: process.execPath,
			cwd: root,
			identityPath,
			stderrPath: artifacts.outputPath,
			stdoutPath: artifacts.outputPath,
		});

		expect(existsSync(markerPath)).toBe(false);
		expect(readlinkSync(`/proc/${payload.pid}/fd/1`)).toBe(artifacts.outputPath);
		expect(readlinkSync(`/proc/${payload.pid}/fd/2`)).toBe(artifacts.outputPath);
		expect(readFileSync(`/proc/${payload.pid}/status`, "utf8")).toContain(`PPid:\t${process.pid}`);

		payload.persistIdentity();
		expect(JSON.parse(readFileSync(identityPath, "utf8"))).toMatchObject({ pid: payload.pid });
		payload.release();
		expect(await payload.waitForExit()).toEqual({ exitCode: 0, signal: null });
		expect(readFileSync(markerPath, "utf8")).toBe("ran");
		expect(readFileSync(artifacts.outputPath, "utf8")).toContain("output");
	});
});
