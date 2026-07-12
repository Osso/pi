import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createDetachedJobArtifacts, createDetachedJobTerminalInput } from "../src/core/detached-job-runner.ts";
import { testProcessIdentity } from "./helpers/process-identity.ts";

const identity = {
	jobId: "job-1",
	owner: { agentId: null, sessionId: "supervisor-1" },
	outputLabel: "Bash output",
	processIdentity: testProcessIdentity("runtime-1"),
};

describe("detached job runner artifacts", () => {
	it("builds an immutable terminal input from the completed output artifact", () => {
		const root = mkdtempSync(`${tmpdir()}/pi-detached-job-`);
		const artifacts = createDetachedJobArtifacts(root, identity.jobId);
		writeFileSync(artifacts.outputPath, "stdout\nstderr\n", { mode: 0o600 });

		expect(
			createDetachedJobTerminalInput(
				artifacts,
				identity,
				{ exitCode: 0, kind: "completed", summary: "done" },
				"2026-07-11T22:00:00.000Z",
			),
		).toEqual({
			...identity,
			outcome: { exitCode: 0, kind: "completed", summary: "done" },
			output: {
				label: "Bash output",
				path: artifacts.outputPath,
				sha256: "f7047c7da981acbadc372dd699784ec46eda4ffb15c03fe25ac25bc595eed04b",
				size: 14,
			},
			terminalAt: "2026-07-11T22:00:00.000Z",
		});
	});

	it("rejects job IDs that escape their artifact root", () => {
		const root = mkdtempSync(`${tmpdir()}/pi-detached-job-`);
		expect(() => createDetachedJobArtifacts(root, "../escape")).toThrow("Detached job ID must be one path segment");
	});
});
