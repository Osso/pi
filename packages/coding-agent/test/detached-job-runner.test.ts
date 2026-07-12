import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createDetachedJobArtifacts,
	readDetachedJobTerminalEnvelope,
	writeDetachedJobTerminalEnvelope,
} from "../src/core/detached-job-runner.ts";
import { testProcessIdentity } from "./helpers/process-identity.ts";

const identity = {
	jobId: "job-1",
	owner: { agentId: null, sessionId: "supervisor-1" },
	outputLabel: "Bash output",
	processIdentity: testProcessIdentity("runtime-1"),
};

describe("detached job runner artifacts", () => {
	it("writes and validates an immutable identity-bound terminal envelope", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-detached-job-"));
		const artifacts = createDetachedJobArtifacts(root, identity.jobId);
		writeFileSync(artifacts.outputPath, "stdout\nstderr\n", { mode: 0o600 });

		const written = writeDetachedJobTerminalEnvelope(
			artifacts,
			identity,
			{ exitCode: 0, kind: "completed", summary: "done" },
			"2026-07-11T22:00:00.000Z",
		);
		const restored = readDetachedJobTerminalEnvelope(artifacts.terminalEnvelopePath);

		expect(restored).toEqual(written);
		expect(restored).toMatchObject({
			...identity,
			outcome: { exitCode: 0, kind: "completed", summary: "done" },
			output: { path: artifacts.outputPath, size: 14 },
			terminalAt: "2026-07-11T22:00:00.000Z",
			version: 1,
		});
		expect(readFileSync(artifacts.terminalEnvelopePath, "utf8")).toBe(`${JSON.stringify(written)}\n`);
	});

	it("rejects output mutation after terminal envelope creation", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-detached-job-"));
		const artifacts = createDetachedJobArtifacts(root, identity.jobId);
		writeFileSync(artifacts.outputPath, "original", { mode: 0o600 });
		writeDetachedJobTerminalEnvelope(
			artifacts,
			identity,
			{ kind: "aborted", reason: "cancelled" },
			"2026-07-11T22:00:00.000Z",
		);
		writeFileSync(artifacts.outputPath, "changed", { mode: 0o600 });

		expect(() => readDetachedJobTerminalEnvelope(artifacts.terminalEnvelopePath)).toThrow(
			"Detached job output integrity mismatch",
		);
	});

	it("rejects envelope tampering", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-detached-job-"));
		const artifacts = createDetachedJobArtifacts(root, identity.jobId);
		writeFileSync(artifacts.outputPath, "output", { mode: 0o600 });
		writeDetachedJobTerminalEnvelope(
			artifacts,
			identity,
			{ error: { message: "failed" }, kind: "failed" },
			"2026-07-11T22:00:00.000Z",
		);
		const envelope = JSON.parse(readFileSync(artifacts.terminalEnvelopePath, "utf8")) as Record<string, unknown>;
		envelope.processIdentity = testProcessIdentity("tampered-owner");
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
