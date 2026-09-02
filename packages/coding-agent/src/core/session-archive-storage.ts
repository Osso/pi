import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { archiveSession, relocateSessionControlData, unarchiveSession } from "./session-control-db.ts";

export const ARCHIVED_SESSION_SUFFIX = ".zst";

export function isArchivedSessionFile(sessionPath: string): boolean {
	return sessionPath.endsWith(ARCHIVED_SESSION_SUFFIX);
}

export function archivePersistedSession(controlDbPath: string, sessionPath: string): string {
	const archivedPath = archiveSessionFile(sessionPath);
	relocateSessionControlData(controlDbPath, sessionPath, archivedPath);
	archiveSession(controlDbPath, archivedPath);
	return archivedPath;
}

export function restoreArchivedSession(controlDbPath: string, sessionPath: string): string {
	const restoredPath = restoreArchivedSessionFile(sessionPath);
	relocateSessionControlData(controlDbPath, sessionPath, restoredPath);
	unarchiveSession(controlDbPath, restoredPath);
	return restoredPath;
}

export function archiveSessionFile(sessionPath: string): string {
	if (isArchivedSessionFile(sessionPath)) return sessionPath;
	const archivedPath = `${sessionPath}${ARCHIVED_SESSION_SUFFIX}`;
	writeCompressedSessionFile(sessionPath, archivedPath);
	return archivedPath;
}

export function restoreArchivedSessionFile(sessionPath: string): string {
	if (!isArchivedSessionFile(sessionPath)) return sessionPath;
	const restoredPath = sessionPath.slice(0, -ARCHIVED_SESSION_SUFFIX.length);
	if (!existsSync(sessionPath)) {
		if (existsSync(restoredPath)) return restoredPath;
		throw new Error(`Archived session file does not exist: ${sessionPath}`);
	}
	writeDecompressedSessionFile(sessionPath, restoredPath);
	return restoredPath;
}

function writeCompressedSessionFile(sessionPath: string, archivedPath: string): void {
	if (!existsSync(sessionPath)) throw new Error(`Session file does not exist: ${sessionPath}`);
	if (existsSync(archivedPath)) throw new Error(`Archived session file already exists: ${archivedPath}`);
	const original = readFileSync(sessionPath);
	const compressed = zstdCompressSync(original);
	if (!zstdDecompressSync(compressed).equals(original)) {
		throw new Error(`Compressed session validation failed: ${sessionPath}`);
	}
	replaceSessionFile(sessionPath, archivedPath, compressed);
}

function writeDecompressedSessionFile(sessionPath: string, restoredPath: string): void {
	if (existsSync(restoredPath)) throw new Error(`Restored session file already exists: ${restoredPath}`);
	const restored = zstdDecompressSync(readFileSync(sessionPath));
	replaceSessionFile(sessionPath, restoredPath, restored);
}

function replaceSessionFile(sourcePath: string, targetPath: string, content: Buffer): void {
	const mode = statSync(sourcePath).mode & 0o777;
	const temporaryPath = `${targetPath}.archive-temp-${randomUUID()}`;
	try {
		writeFileSync(temporaryPath, content, { flag: "wx", mode });
		chmodSync(temporaryPath, mode);
		renameSync(temporaryPath, targetPath);
		unlinkSync(sourcePath);
	} catch (error) {
		rmSync(temporaryPath, { force: true });
		if (existsSync(sourcePath) && existsSync(targetPath)) rmSync(targetPath, { force: true });
		throw error;
	}
}
