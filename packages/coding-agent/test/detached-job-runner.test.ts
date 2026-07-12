import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createDetachedJobArtifacts,
	readDetachedJobTerminalEnvelope,
	writeDetachedJobTerminalEnvelope,
} from "../src/core/detached-job-runner.ts";

const identity = {
	expectedRevision: 4,
	fencingEpoch: 7,
	jobId: "job-1",
	leaseId: "lease-1",
	runtimeIncarnation: "runtime-1",
};

describe("detached job runner artifacts", () => {
	it("writes and validates an immutable identity-bound terminal envelope", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-detached-job-"));
		const artifacts = createDetachedJobArtifacts(root, identity.jobId);
		writeFileSync(artifacts.outputPath, "stdout\nstderr\n", { mode: 0o600 });

		const written = writeDetachedJobTerminalEnvelope(artifacts, identity, {
			exitCode: 0,
			kind: "completed",
			summary: "done",
		});
		const restored = readDetachedJobTerminalEnvelope(artifacts.terminalEnvelopePath);

		expect(restored).toEqual(written);
		expect(restored).toMatchObject({
			...identity,
			outcome: { exitCode: 0, kind: "completed", summary: "done" },
			output: { path: artifacts.outputPath, size: 14 },
			version: 1,
		});
		expect(readFileSync(artifacts.terminalEnvelopePath, "utf8")).toBe(`${JSON.stringify(written)}\n`);
	});

	it("rejects output mutation after terminal envelope creation", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-detached-job-"));
		const artifacts = createDetachedJobArtifacts(root, identity.jobId);
		writeFileSync(artifacts.outputPath, "original", { mode: 0o600 });
		writeDetachedJobTerminalEnvelope(artifacts, identity, { kind: "aborted", reason: "cancelled" });
		writeFileSync(artifacts.outputPath, "changed", { mode: 0o600 });

		expect(() => readDetachedJobTerminalEnvelope(artifacts.terminalEnvelopePath)).toThrow(
			"Detached job output integrity mismatch",
		);
	});

	it("rejects envelope tampering", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-detached-job-"));
		const artifacts = createDetachedJobArtifacts(root, identity.jobId);
		writeFileSync(artifacts.outputPath, "output", { mode: 0o600 });
		writeDetachedJobTerminalEnvelope(artifacts, identity, { error: { message: "failed" }, kind: "failed" });
		const envelope = JSON.parse(readFileSync(artifacts.terminalEnvelopePath, "utf8")) as Record<string, unknown>;
		envelope.fencingEpoch = 8;
		writeFileSync(artifacts.terminalEnvelopePath, JSON.stringify(envelope));

		expect(() => readDetachedJobTerminalEnvelope(artifacts.terminalEnvelopePath)).toThrow(
			"Invalid detached job terminal envelope",
		);
	});

	it("rejects job IDs that escape their artifact root", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-detached-job-"));
		chmodSync(root, 0o700);
		expect(() => createDetachedJobArtifacts(root, "../escape")).toThrow("Detached job ID must be one path segment");
	});
});
