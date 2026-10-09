import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimCodexRestrictionRecovery, retainControlDbConnection } from "../src/core/session-control-db.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";

const controlModuleUrl = pathToFileURL(join(import.meta.dirname, "../src/core/session-control-db.ts")).href;

interface ClaimProcess {
	child: ChildProcess;
	ready: Promise<unknown>;
	result: Promise<{ code: number | null; claimed: unknown; stderr: string }>;
}

function spawnClaimProcess(controlDbPath: string, userRequestId: string): ClaimProcess {
	const source = `
		import * as control from ${JSON.stringify(controlModuleUrl)};
		process.once("message", () => {
			const claimed = control.claimCodexRestrictionRecovery(process.argv[1], process.argv[2]);
			process.send(claimed, () => process.disconnect());
		});
		process.send("ready");
	`;
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "-e", source, controlDbPath, userRequestId],
		{ stdio: ["ignore", "ignore", "pipe", "ipc"] },
	);
	const ready = once(child, "message").then(([message]) => message);
	let claimed: unknown;
	let stderr = "";
	child.on("message", (message: unknown) => {
		if (message !== "ready") claimed = message;
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const result = once(child, "close").then(([code]) => ({ code: code as number | null, claimed, stderr }));
	return { child, ready, result };
}

describe("claimCodexRestrictionRecovery durable request budget", () => {
	let tempDir: string;
	let controlDbPath: string;
	let children: ChildProcess[];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-codex-recovery-claim-"));
		controlDbPath = join(tempDir, "control.sqlite");
		children = [];
	});

	afterEach(async () => {
		await Promise.all(
			children.map(async (child) => {
				if (child.exitCode !== null || child.signalCode !== null) return;
				const closed = once(child, "close");
				child.kill();
				await closed;
			}),
		);
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("claims once and rejects repeated calls for the same explicit request UUID", () => {
		const requestId = randomUUID();
		expect(claimCodexRestrictionRecovery(controlDbPath, requestId)).toBe(true);
		expect(claimCodexRestrictionRecovery(controlDbPath, requestId)).toBe(false);
		expect(claimCodexRestrictionRecovery(controlDbPath, requestId)).toBe(false);
	});

	it("preserves the claim after releasing and reopening the control database", () => {
		const requestId = randomUUID();
		const release = retainControlDbConnection(controlDbPath);
		try {
			expect(claimCodexRestrictionRecovery(controlDbPath, requestId)).toBe(true);
		} finally {
			release();
		}
		const releaseReopened = retainControlDbConnection(controlDbPath);
		try {
			expect(claimCodexRestrictionRecovery(controlDbPath, requestId)).toBe(false);
		} finally {
			releaseReopened();
		}
	});

	it("gives a distinct request UUID its own claim", () => {
		const first = randomUUID();
		const second = randomUUID();
		expect(claimCodexRestrictionRecovery(controlDbPath, first)).toBe(true);
		expect(claimCodexRestrictionRecovery(controlDbPath, second)).toBe(true);
		expect(claimCodexRestrictionRecovery(controlDbPath, first)).toBe(false);
		expect(claimCodexRestrictionRecovery(controlDbPath, second)).toBe(false);
	});

	it.each(["", " ", "\t\n"])("rejects empty request ID %j before creating a database", (requestId) => {
		expect(() => claimCodexRestrictionRecovery(controlDbPath, requestId)).toThrow(/request.*(empty|required)/i);
		expect(existsSync(controlDbPath)).toBe(false);
	});

	it("stores only the request ID and claim timestamp without rewriting a repeated claim", () => {
		const requestId = randomUUID();
		const before = new Date().toISOString();
		expect(claimCodexRestrictionRecovery(controlDbPath, requestId)).toBe(true);
		const db = createSqliteDatabase(controlDbPath);
		try {
			const rows = db.prepare("SELECT * FROM codex_restriction_recovery_claims").all();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toEqual({ user_request_id: requestId, claimed_at: expect.any(String) });
			const row = rows[0] as { user_request_id: string; claimed_at: string };
			expect(row.claimed_at >= before).toBe(true);
			expect(row.claimed_at <= new Date().toISOString()).toBe(true);
			expect(claimCodexRestrictionRecovery(controlDbPath, requestId)).toBe(false);
			expect(db.prepare("SELECT * FROM codex_restriction_recovery_claims").all()).toEqual(rows);
		} finally {
			db.close();
		}
	});

	it("preserves an existing claim in a fresh process", async () => {
		const requestId = randomUUID();
		expect(claimCodexRestrictionRecovery(controlDbPath, requestId)).toBe(true);
		const claimant = spawnClaimProcess(controlDbPath, requestId);
		children.push(claimant.child);
		expect(await claimant.ready).toBe("ready");
		claimant.child.send("claim");
		const result = await claimant.result;
		expect(result.code, result.stderr).toBe(0);
		expect(result.claimed).toBe(false);
	}, 15_000);

	it("allows exactly one winner among simultaneous processes sharing the control database", async () => {
		const release = retainControlDbConnection(controlDbPath);
		release();
		const requestId = randomUUID();
		const claimants = Array.from({ length: 6 }, () => spawnClaimProcess(controlDbPath, requestId));
		children.push(...claimants.map(({ child }) => child));
		expect(await Promise.all(claimants.map(({ ready }) => ready))).toEqual(Array(6).fill("ready"));
		for (const { child } of claimants) child.send("claim");
		const results = await Promise.all(claimants.map(({ result }) => result));
		for (const result of results) {
			expect(result.code, result.stderr).toBe(0);
			expect(typeof result.claimed).toBe("boolean");
		}
		expect(results.filter(({ claimed }) => claimed === true)).toHaveLength(1);
		expect(results.filter(({ claimed }) => claimed === false)).toHaveLength(5);
		expect(claimCodexRestrictionRecovery(controlDbPath, requestId)).toBe(false);
	}, 15_000);
});
