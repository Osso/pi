import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDurableDetachablePyrunEvaluation } from "../extensions/pyrun/src/detached-evaluation.ts";
import type { PyrunArtifactRecord } from "../extensions/pyrun/src/detached-progress.ts";
import { readDetachedPyrunLaunchManifest } from "../extensions/pyrun/src/detached-runner.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { getControlDbPath, readMultiAgentAgent } from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { ToolDetachRegistry } from "../src/core/tool-detach-registry.ts";
import { terminateDetachedPyrunTestProcesses } from "./helpers/detached-process-cleanup.ts";

const MIB = 1024 * 1024;
const CAP = 50 * MIB;
const roots: string[] = [];

afterEach(async () => {
	await terminateDetachedPyrunTestProcesses(roots);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function progressLine(index: number): string {
	return `${JSON.stringify({ kind: "progress", update: { type: "console", stream: "stdout", text: `${index}:é${"x".repeat(MIB)}\n` } })}\n`;
}

async function startFlood(count: number, resultBytes = 0, fail = false) {
	const root = mkdtempSync(join(tmpdir(), "pi-pyrun-log-cap-"));
	roots.push(root);
	const program = join(root, "flood.mjs");
	writeFileSync(
		program,
		[
			"import { once } from 'node:events';",
			"import { existsSync, writeFileSync } from 'node:fs';",
			"import { createInterface } from 'node:readline';",
			"const lines = createInterface({ input: process.stdin });",
			"await once(lines, 'line');",
			`for (let index = 0; index < ${count}; index++) {`,
			` const update = { type: 'console', stream: 'stdout', text: index + ':é' + 'x'.repeat(${MIB}) + '\\n' };`,
			" if (!process.stdout.write(JSON.stringify(update) + '\\n')) await once(process.stdout, 'drain');",
			"}",
			`writeFileSync(${JSON.stringify(join(root, "ready"))}, 'ready');`,
			`while (!existsSync(${JSON.stringify(join(root, "release"))})) await new Promise(resolve => setTimeout(resolve, 10));`,
			fail
				? "process.exit(7);"
				: `process.stdout.write(JSON.stringify({ type: 'completed', value: 'v'.repeat(${resultBytes}), console: ['terminal console'] }) + '\\n');`,
		].join("\n"),
	);
	const sessionManager = SessionManager.create(root, join(root, "sessions"));
	sessionManager.setMetadataControlDbPath(getControlDbPath(root));
	const store = new MultiAgentStore();
	store.setPersistenceSessionManager(sessionManager);
	const sessionPath = sessionManager.getSessionFile();
	if (!sessionPath) throw new Error("Missing test session");
	const input = {
		agentId: "pyrun_1",
		ctx: { cwd: root, sessionManager, toolExecutionStartedAt: Date.now() } as unknown as ExtensionContext,
		detachRegistry: new ToolDetachRegistry(),
		dispatchPiRequest: async () => {
			throw new Error("Unexpected bridge request");
		},
		params: { code: "flood" },
		piBridgeEnabled: false,
		runnerOptions: { command: process.execPath, args: [program] },
		store,
		toolCallId: "flood-call",
	};
	const directory = join(
		dirname(sessionPath),
		"detached-jobs",
		basename(sessionPath, extname(sessionPath)),
		"pyrun_1",
	);
	const evaluation = runDurableDetachablePyrunEvaluation(input);
	void evaluation.catch(() => undefined);
	await waitFor(() => existsSync(join(root, "ready")));
	return { root, directory, outputPath: join(directory, "output.log"), input, evaluation };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for flood runner");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function release(root: string): void {
	writeFileSync(join(root, "release"), "release");
}

function readRecords(path: string): PyrunArtifactRecord[] {
	return readFileSync(path, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line) as PyrunArtifactRecord);
}

describe("detached Pyrun log cap", () => {
	it("keeps an immutable head and latest records, counts omitted UTF-8 bytes, and reads the final result live and on resume", async () => {
		const fixture = await startFlood(80);
		const prefix = readFileSync(fixture.outputPath);
		expect(prefix.length).toBeLessThanOrEqual(CAP);
		release(fixture.root);
		const final = await fixture.evaluation;
		expect(final.details).toMatchObject({ type: "completed", value: "", console: ["terminal console"] });
		const bytes = readFileSync(fixture.outputPath);
		expect(bytes.length).toBeLessThanOrEqual(CAP);
		expect(bytes.subarray(0, prefix.length).equals(prefix)).toBe(true);
		const records = readRecords(fixture.outputPath);
		const retained = records.flatMap((record) =>
			record.kind === "progress" ? [Number(record.update.text?.split(":")[0])] : [],
		);
		expect(retained[0]).toBe(0);
		expect(retained.at(-1)).toBe(79);
		expect(retained.slice(0, 24)).toEqual(Array.from({ length: 24 }, (_, index) => index));
		expect(retained.slice(24)).toEqual(Array.from({ length: 25 }, (_, index) => index + 55));
		const kept = new Set(retained);
		const missing = Array.from({ length: 80 }, (_, index) => index).filter((index) => !kept.has(index));
		expect(missing.length).toBeGreaterThan(0);
		expect(records.find((record) => record.kind === "truncation")).toMatchObject({
			kind: "truncation",
			omittedBytes: missing.reduce((total, index) => total + Buffer.byteLength(progressLine(index)), 0),
			omittedRecords: missing.length,
		});
		expect(records.at(-1)).toMatchObject({ kind: "result", result: { type: "completed", value: "" } });
		const resumed = await runDurableDetachablePyrunEvaluation(fixture.input);
		expect(resumed.details).toEqual(final.details);
	}, 30_000);

	it("leaves an under-cap job byte-identical, including buffered records", async () => {
		const fixture = await startFlood(30);
		release(fixture.root);
		await fixture.evaluation;
		const expected =
			Array.from({ length: 30 }, (_, index) => progressLine(index)).join("") +
			`${JSON.stringify({ kind: "result", result: { type: "completed", value: "", console: ["terminal console"] } })}\n`;
		expect(readFileSync(fixture.outputPath).equals(Buffer.from(expected))).toBe(true);
	}, 30_000);

	it.each([20, 60])(
		"prioritizes a %i MiB terminal result over the tail, allowing only mandatory overflow",
		async (size) => {
			const fixture = await startFlood(60, size * MIB);
			const prefix = readFileSync(fixture.outputPath);
			release(fixture.root);
			const final = await fixture.evaluation;
			expect(final.details).toMatchObject({ type: "completed", value: "v".repeat(size * MIB) });
			const records = readRecords(fixture.outputPath);
			const terminal = records.at(-1);
			expect(terminal?.kind).toBe("result");
			const mandatoryBytes = prefix.length + Buffer.byteLength(`${JSON.stringify(terminal)}\n`);
			expect(statSync(fixture.outputPath).size).toBeLessThanOrEqual(Math.max(CAP, mandatoryBytes + 256));
			expect(records.some((record) => record.kind === "truncation")).toBe(true);
			if (size === 60)
				expect(records.filter((record) => record.kind === "progress")).toHaveLength(
					prefix.toString().trimEnd().split("\n").length,
				);
		},
		30_000,
	);

	it("finalizes a capped detached job and restores its exact result", async () => {
		const fixture = await startFlood(80);
		expect(fixture.input.detachRegistry.detachRunning()).toBe(true);
		expect((await fixture.evaluation).details).toMatchObject({ type: "detached" });
		release(fixture.root);
		const manifest = readDetachedPyrunLaunchManifest(join(fixture.directory, "launch.json"));
		await waitFor(
			() => readMultiAgentAgent(manifest.controlDbPath, manifest.sessionPath, "pyrun_1")?.lifecycle === "completed",
		);
		expect(statSync(fixture.outputPath).size).toBeLessThanOrEqual(CAP);
		expect(readRecords(fixture.outputPath).at(-1)).toMatchObject({
			kind: "result",
			result: { type: "completed", value: "" },
		});
		const resumed = await runDurableDetachablePyrunEvaluation(fixture.input);
		expect(resumed.details).toMatchObject({ type: "completed", value: "", console: ["terminal console"] });
	}, 30_000);

	it("resumes observation from a live manifest while the tail is buffered", async () => {
		const fixture = await startFlood(80);
		const detachRegistry = new ToolDetachRegistry();
		const resumed = runDurableDetachablePyrunEvaluation({ ...fixture.input, detachRegistry });
		await waitFor(() => detachRegistry.hasRunning());
		release(fixture.root);
		const [original, restored] = await Promise.all([fixture.evaluation, resumed]);
		expect(restored.details).toEqual(original.details);
		expect(restored.details).toMatchObject({ type: "completed", value: "" });
	}, 30_000);

	it("preserves an error settlement after truncation and restores it as an error, not a second terminal record", async () => {
		const fixture = await startFlood(80, 0, true);
		release(fixture.root);
		await expect(fixture.evaluation).rejects.toThrow("Pyrun runner exited with exit code 7");
		const records = readRecords(fixture.outputPath);
		expect(records.at(-1)).toEqual({ kind: "error", error: "Pyrun runner exited with exit code 7" });
		expect(records.some((record) => record.kind === "truncation")).toBe(true);
		const resumed = await runDurableDetachablePyrunEvaluation(fixture.input);
		expect(resumed.details).toMatchObject({ type: "error", error: "Pyrun runner exited with exit code 7" });
		expect(statSync(fixture.outputPath).size).toBeLessThanOrEqual(CAP);
	}, 30_000);

	it("reports lost_runtime after runner death with its persisted head intact and no fabricated result", async () => {
		const fixture = await startFlood(80);
		const manifest = readDetachedPyrunLaunchManifest(join(fixture.directory, "launch.json"));
		process.kill(-manifest.runnerProcessIdentity.pid, "SIGKILL");
		await expect(fixture.evaluation).rejects.toThrow("exited without producing a result");
		const resumed = await runDurableDetachablePyrunEvaluation(fixture.input);
		expect(resumed.details).toMatchObject({ type: "lost_runtime", outputPath: fixture.outputPath });
		expect(statSync(fixture.outputPath).size).toBeLessThanOrEqual(CAP);
		expect(readRecords(fixture.outputPath).every((record) => record.kind === "progress")).toBe(true);
	}, 30_000);
});
