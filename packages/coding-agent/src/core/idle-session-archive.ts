import { randomUUID } from "node:crypto";
import {
	chmodSync,
	createReadStream,
	createWriteStream,
	existsSync,
	linkSync,
	lstatSync,
	readdirSync,
	realpathSync,
	rmSync,
	type Stats,
	unlinkSync,
	utimesSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdCompress, createZstdDecompress } from "node:zlib";
import { getAgentDir } from "../config.ts";
import { readLinuxProcessReferences } from "./detached-job-cleanup.ts";
import { isResidentSession } from "./resident-session.ts";
import {
	listRuntimeMailboxListeners,
	readSessionMetadata,
	relocateAndArchiveSession,
	relocateAndUnarchiveSession,
	writeSessionMetadata,
} from "./session-control-db.ts";
import { buildSessionInfo } from "./session-manager.ts";
import { configureReadOnlySqliteDatabase, createReadOnlySqliteDatabase } from "./sqlite.ts";

const IDLE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIVE_AGENT_TRANSCRIPTS_SQL = `
	SELECT session_path AS path FROM multi_agent_agents
	WHERE NOT json_valid(data) OR COALESCE(json_extract(data, '$.lifecycle'), '') NOT IN ('completed', 'failed', 'aborted')
	UNION SELECT json_extract(data, '$.transcript.path') AS path FROM multi_agent_agents
	WHERE json_valid(data) AND COALESCE(json_extract(data, '$.lifecycle'), '') NOT IN ('completed', 'failed', 'aborted')
	UNION SELECT session_path AS path FROM multi_agent_runtime_owners WHERE process_identity IS NOT NULL
`;

export interface IdleSessionArchiveResult {
	archivedPaths: string[];
	errors: string[];
}

/** One pass, restricted to normal project session directories. No detached artifacts or residents. */
export async function archiveIdleSessionTranscripts(
	controlDbPath: string,
	options: { agentDir?: string; now?: number; currentSessionPath?: string } = {},
): Promise<IdleSessionArchiveResult> {
	const result: IdleSessionArchiveResult = { archivedPaths: [], errors: [] };
	const root = join(options.agentDir ?? getAgentDir(), "sessions");
	if (!existsSync(root)) return result;
	const references = readLinuxProcessReferences();
	if (!references) return result;
	const protectedPaths = readProtectedTranscriptPaths(controlDbPath);
	if (options.currentSessionPath) protectedPaths.add(resolve(options.currentSessionPath));
	const cutoff = (options.now ?? Date.now()) - IDLE_AGE_MS;
	for (const path of listProjectTranscripts(root)) {
		try {
			if (references.has(realpathSync(path)) || protectedPaths.has(resolve(path))) continue;
			if (await archiveIdleTranscript(controlDbPath, path, cutoff)) result.archivedPaths.push(`${path}.zst`);
		} catch (error) {
			result.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return result;
}

export function runIdleSessionArchive(controlDbPath: string, agentDir: string, currentSessionPath?: string): void {
	void archiveIdleSessionTranscripts(controlDbPath, { agentDir, currentSessionPath }).then(
		(result) => {
			for (const error of result.errors) console.error(`Idle session archive: ${error}`);
		},
		(error) => console.error("Idle session archive failed:", error),
	);
}

function listProjectTranscripts(root: string): string[] {
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.flatMap((directory) => {
			const dir = join(root, directory.name);
			return readdirSync(dir, { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
				.map((entry) => join(dir, entry.name));
		});
}

function isProcessPresent(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}

/** Protect both a store's transcript and the separate transcript paths of its active children. */
function readProtectedTranscriptPaths(controlDbPath: string): Set<string> {
	const paths = new Set<string>();
	for (const listener of listRuntimeMailboxListeners(controlDbPath)) {
		if (listener.sessionPath && isProcessPresent(listener.pid)) paths.add(resolve(listener.sessionPath));
	}
	const db = createReadOnlySqliteDatabase(controlDbPath);
	try {
		configureReadOnlySqliteDatabase(db);
		const rows = db.prepare(ACTIVE_AGENT_TRANSCRIPTS_SQL).all() as { path: string | null }[];
		for (const row of rows) if (row.path) paths.add(resolve(row.path));
		const health = db
			.prepare(`SELECT metadata.session_path AS path, health.pid FROM session_metadata AS metadata
			JOIN session_health AS health ON health.session_id = metadata.id WHERE health.pid IS NOT NULL`)
			.all() as { path: string; pid: number }[];
		for (const row of health) if (isProcessPresent(row.pid)) paths.add(resolve(row.path));
	} finally {
		db.close();
	}
	return paths;
}

async function archiveIdleTranscript(controlDbPath: string, path: string, cutoff: number): Promise<boolean> {
	const before = lstatSync(path);
	if (!before.isFile() || before.mtimeMs >= cutoff || existsSync(`${path}.zst`)) return false;
	const metadata = readSessionMetadata(controlDbPath, path);
	if (metadata && isResidentSession({ id: metadata.id, path })) return false;
	const temp = `${path}.archive-temp-${randomUUID()}`;
	try {
		await pipeline(
			createReadStream(path),
			createZstdCompress(),
			createWriteStream(temp, { flags: "wx", mode: before.mode & 0o777 }),
		);
		await verifyArchiveBytes(path, temp);
		if (!metadata && !(await indexTranscript(controlDbPath, path))) return false;
		if (!canPublishArchivedTranscript(controlDbPath, path, before)) return false;
		chmodSync(temp, before.mode & 0o777);
		utimesSync(temp, before.atime, before.mtime);
		publishArchivedTranscript(controlDbPath, path, temp);
		return true;
	} finally {
		rmSync(temp, { force: true });
	}
}

function canPublishArchivedTranscript(controlDbPath: string, path: string, before: Stats): boolean {
	const references = readLinuxProcessReferences();
	if (
		!references ||
		references.has(realpathSync(path)) ||
		readProtectedTranscriptPaths(controlDbPath).has(resolve(path))
	)
		return false;
	const after = lstatSync(path);
	return (
		before.dev === after.dev &&
		before.ino === after.ino &&
		before.size === after.size &&
		before.mtimeMs === after.mtimeMs &&
		before.ctimeMs === after.ctimeMs
	);
}

async function indexTranscript(controlDbPath: string, path: string): Promise<boolean> {
	const info = await buildSessionInfo(path);
	if (!info || isResidentSession(info)) return false;
	writeSessionMetadata(controlDbPath, {
		sessionPath: path,
		id: info.id,
		cwd: info.cwd,
		parentSessionPath: info.parentSessionPath,
		createdAt: info.created.toISOString(),
		modifiedAt: info.modified.toISOString(),
		messageCount: info.messageCount,
		firstMessage: info.firstMessage,
	});
	return true;
}

/** Exact bounded-memory comparison, including original EOF; not just a decompressor CRC check. */
async function verifyArchiveBytes(original: string, archive: string): Promise<void> {
	const source = await open(original, "r");
	try {
		const decoded = createReadStream(archive).compose(createZstdDecompress());
		let position = 0;
		for await (const chunk of decoded) {
			const bytes = chunk as Buffer;
			const expected = Buffer.allocUnsafe(bytes.length);
			let read = 0;
			while (read < bytes.length) {
				const part = await source.read(expected, read, bytes.length - read, position + read);
				if (part.bytesRead === 0) throw new Error(`Archive differs from original: ${original}`);
				read += part.bytesRead;
			}
			if (!expected.equals(bytes)) throw new Error(`Archive differs from original: ${original}`);
			position += bytes.length;
		}
		if ((await source.stat()).size !== position) throw new Error(`Archive length differs from original: ${original}`);
	} finally {
		await source.close();
	}
}

function publishArchivedTranscript(controlDbPath: string, source: string, temp: string): void {
	const target = `${source}.zst`;
	linkSync(temp, target); // Atomic publication without overwriting another pass's archive.
	try {
		relocateAndArchiveSession(controlDbPath, source, target);
		try {
			unlinkSync(source);
		} catch (error) {
			relocateAndUnarchiveSession(controlDbPath, target, source);
			throw error;
		}
	} catch (error) {
		rmSync(target, { force: true });
		throw error;
	}
}
