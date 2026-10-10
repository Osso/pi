import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/config.ts";
import { isProcessIdentityAlive, type ProcessIdentity } from "../../src/core/runtime-process.ts";
import {
	enqueueStoredRuntimeMailboxMessage,
	getControlDbPath,
	listRuntimeMailboxMessages,
} from "../../src/core/session-control-db.ts";
import { createHeadlessPaths, withHeadlessPi } from "./headless-pi.ts";

interface RelayIdentity extends ProcessIdentity {
	version: string;
}

function readResident(db: string): RelayIdentity | undefined {
	try {
		return JSON.parse(readFileSync(`${db}.relay.json`, "utf8")) as RelayIdentity;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function stopResident(db: string): Promise<void> {
	const resident = readResident(db);
	if (!resident || !isProcessIdentityAlive(resident)) return;
	process.kill(resident.pid, "SIGTERM");
	try {
		await expect.poll(() => isProcessIdentityAlive(resident), { timeout: 5000 }).toBe(false);
	} finally {
		if (isProcessIdentityAlive(resident)) process.kill(resident.pid, "SIGKILL");
	}
}

function installFakeSsh(directory: string): { starts: string; remoteDb: string; peerPid: string } {
	const starts = join(directory, "starts");
	const remoteDb = join(directory, "peer.sqlite");
	const peerPid = join(directory, "peer-pid");
	const fixture = join(directory, "fake-ssh.mjs");
	const moduleUrl = pathToFileURL(join(import.meta.dirname, "../../src/core/host-relay.ts")).href;
	writeFileSync(
		fixture,
		`#!${process.execPath} --experimental-strip-types
import { appendFileSync, writeFileSync } from "node:fs";
import { runHostRelay } from ${JSON.stringify(moduleUrl)};
appendFileSync(${JSON.stringify(starts)}, process.ppid + "\\n");
writeFileSync(${JSON.stringify(peerPid)}, String(process.pid));
await runHostRelay({ controlDbPath: ${JSON.stringify(remoteDb)}, host: "fake-peer", input: process.stdin, output: process.stdout, pollMs: 20 });
`,
		{ mode: 0o755 },
	);
	symlinkSync(fixture, join(directory, "ssh"));
	return { starts, remoteDb, peerPid };
}

function configureRelay(agentDir: string): void {
	const path = join(agentDir, "settings.json");
	const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
	writeFileSync(
		path,
		JSON.stringify({ ...settings, relay: { peer: "fake-peer", remoteCommand: "fake relay serve" } }),
	);
}

function queueMessage(db: string): void {
	enqueueStoredRuntimeMailboxMessage(db, {
		kind: "message",
		recipientHost: "fake-peer",
		recipient: { sessionId: "remote", agentId: null },
		sender: { sessionId: "local", agentId: null },
		storeRef: { sessionPath: "/local/relay.jsonl", messageId: "startup-message" },
		message: {
			id: "startup-message",
			kind: "message",
			status: "pending",
			fromAgentId: "main",
			toAgentId: "main",
			body: "delivered without asking Supervisor",
			createdAt: new Date().toISOString(),
		},
	});
}

describe("Pi-managed relay resident", () => {
	it("starts exactly one client for concurrent RPC sessions, delivers queued work without Supervisor, and stops on SIGTERM", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-resident-ssh-"));
		const fake = installFakeSsh(directory);
		try {
			await withHeadlessPi(
				async (pi) => {
					const db = getControlDbPath(pi.paths.agentDir);
					configureRelay(pi.paths.agentDir);
					queueMessage(db);
					try {
						await Promise.all([pi.startSharedSession(), pi.startSharedSession()]);
						await expect.poll(() => readResident(db), { timeout: 15000 }).toMatchObject({ version: VERSION });
						const resident = readResident(db)!;
						await expect
							.poll(() => listRuntimeMailboxMessages(fake.remoteDb), { timeout: 15000 })
							.toHaveLength(1);
						expect(readFileSync(fake.starts, "utf8").trim().split("\n")).toEqual([String(resident.pid)]);
						expect(pi.countSupervisorRequests("supervisor_advisory")).toBe(0);
						expect(listRuntimeMailboxMessages(db)).toHaveLength(0);
						await pi.restart();
						expect(readResident(db)?.pid).toBe(resident.pid);
						expect(readFileSync(fake.starts, "utf8").trim().split("\n")).toEqual([String(resident.pid)]);
						await stopResident(db);
						expect(readResident(db)).toBeUndefined();
						expect(() => process.kill(Number(readFileSync(fake.peerPid, "utf8")), 0)).toThrow();
					} finally {
						await stopResident(db);
					}
				},
				{ env: { PATH: `${directory}:${process.env.PATH}` } },
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60000);

	it("replaces a verified resident advertising an older version on the next session startup", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-resident-upgrade-"));
		installFakeSsh(directory);
		try {
			await withHeadlessPi(
				async (pi) => {
					const db = getControlDbPath(pi.paths.agentDir);
					configureRelay(pi.paths.agentDir);
					try {
						await pi.startSharedSession();
						await expect.poll(() => readResident(db), { timeout: 15000 }).toMatchObject({ version: VERSION });
						const old = readResident(db)!;
						writeFileSync(`${db}.relay.json`, JSON.stringify({ ...old, version: "0.0.0" }));
						await pi.startSharedSession();
						await expect.poll(() => readResident(db), { timeout: 15000 }).toMatchObject({ version: VERSION });
						expect(readResident(db)!.pid).not.toBe(old.pid);
						expect(isProcessIdentityAlive(old)).toBe(false);
					} finally {
						await stopResident(db);
					}
				},
				{ env: { PATH: `${directory}:${process.env.PATH}` } },
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60000);

	it("spawns nothing when global relay settings are absent", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-resident-absent-"));
		const fake = installFakeSsh(directory);
		try {
			await withHeadlessPi(
				async (pi) => {
					await pi.startSharedSession();
					const db = getControlDbPath(pi.paths.agentDir);
					expect(readResident(db)).toBeUndefined();
					expect(existsSync(`${db}.relay.log`)).toBe(false);
					expect(existsSync(fake.starts)).toBe(false);
				},
				{ env: { PATH: `${directory}:${process.env.PATH}` } },
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60000);

	it("does not block RPC readiness while another process holds the relay startup lock", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-resident-lock-"));
		installFakeSsh(directory);
		try {
			await withHeadlessPi(
				async (pi) => {
					const db = getControlDbPath(pi.paths.agentDir);
					configureRelay(pi.paths.agentDir);
					const release = await lockfile.lock(db, {
						realpath: false,
						lockfilePath: `${db}.relay-start.lock`,
						stale: 5000,
						update: 1000,
					});
					try {
						await pi.startSharedSession();
						expect(readResident(db)).toBeUndefined();
					} finally {
						await release();
					}
					try {
						await expect.poll(() => readResident(db), { timeout: 15000 }).toMatchObject({ version: VERSION });
					} finally {
						await stopResident(db);
					}
				},
				{ env: { PATH: `${directory}:${process.env.PATH}` } },
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60000);

	it("standalone workers do not start relay even when configured", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-resident-worker-"));
		const fake = installFakeSsh(directory);
		try {
			await withHeadlessPi(
				async (pi) => {
					configureRelay(pi.paths.agentDir);
					await pi.restart();
					const db = getControlDbPath(pi.paths.agentDir);
					expect(readResident(db)).toBeUndefined();
					expect(existsSync(`${db}.relay.log`)).toBe(false);
					expect(existsSync(fake.starts)).toBe(false);
				},
				{ noSupervisor: true, env: { PATH: `${directory}:${process.env.PATH}` } },
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60000);

	it("relay connect exits successfully without relay settings", async () => {
		const paths = createHeadlessPaths();
		const child = spawn(
			process.execPath,
			["--experimental-strip-types", join(import.meta.dirname, "../../src/cli.ts"), "relay", "connect"],
			{
				cwd: paths.workspaceDir,
				env: { ...process.env, PI_CODING_AGENT_DIR: paths.agentDir, PI_CODING_AGENT_STATE_DIR: paths.agentDir },
				stdio: "ignore",
			},
		);
		try {
			const exited = new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("exit", resolve);
			});
			const code = await Promise.race([
				exited,
				new Promise<never>((_resolve, reject) =>
					setTimeout(() => reject(new Error("relay connect did not exit")), 10000).unref(),
				),
			]);
			expect(code).toBe(0);
		} finally {
			child.kill("SIGKILL");
			rmSync(paths.tempDir, { recursive: true, force: true });
		}
	}, 15000);
});
