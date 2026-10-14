import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { listDescendantSessionPaths, removeSessionsMetadata } from "./session-control-db.ts";

export type SessionDeleteResult = { ok: true; method: "trash" | "unlink" } | { ok: false; error: string };

/**
 * Deletes a session tree, preferring trash over permanent deletion. Only removed transcripts lose their metadata,
 * including files already removed by a partially successful trash invocation.
 */
export async function deleteSessionTree(
	sessionPath: string,
	controlDbPath: string | undefined,
): Promise<SessionDeleteResult> {
	const deletedPaths: string[] = [];
	let result: SessionDeleteResult = { ok: true, method: "trash" };
	try {
		const sessionPaths = controlDbPath
			? [...listDescendantSessionPaths(controlDbPath, sessionPath), sessionPath]
			: [sessionPath];
		for (const paths of chunkSessionPaths(sessionPaths)) {
			const batchResult = await deleteSessionBatch(paths, deletedPaths);
			if (!batchResult.ok) {
				result = batchResult;
				break;
			}
			if (batchResult.method === "unlink") result = batchResult;
		}
	} catch (error) {
		result = { ok: false, error: `Cannot delete session tree ${sessionPath}: ${String(error)}` };
	}
	try {
		if (controlDbPath && deletedPaths.length > 0) removeSessionsMetadata(controlDbPath, deletedPaths);
	} catch (error) {
		result = {
			ok: false,
			error: `Cannot clean metadata for ${deletedPaths.length} deleted transcripts under ${sessionPath}: ${String(error)}`,
		};
	}
	return result;
}

async function deleteSessionBatch(paths: readonly string[], deletedPaths: string[]): Promise<SessionDeleteResult> {
	const trashError = await trashSessionFiles(paths);
	const remainingPaths: string[] = [];
	for (const path of paths) {
		if (existsSync(path)) remainingPaths.push(path);
		else deletedPaths.push(path);
	}
	for (const path of remainingPaths) {
		try {
			await unlink(path);
			deletedPaths.push(path);
		} catch (error) {
			const unlinkError = error instanceof Error ? error.message : String(error);
			return { ok: false, error: trashError ? `${unlinkError} (trash: ${trashError})` : unlinkError };
		}
	}
	return { ok: true, method: remainingPaths.length > 0 ? "unlink" : "trash" };
}

function* chunkSessionPaths(paths: readonly string[]): Generator<string[]> {
	// Stay below Linux's per-argument limit and leave ample ARG_MAX space for the environment and argv pointers.
	const byteBudget = 64 * 1024;
	let chunk: string[] = [];
	let bytes = 0;
	for (const path of paths) {
		const pathBytes = Buffer.byteLength(path) + 1 + 8;
		if (chunk.length > 0 && bytes + pathBytes > byteBudget) {
			yield chunk;
			chunk = [];
			bytes = 0;
		}
		chunk.push(path);
		bytes += pathBytes;
	}
	if (chunk.length > 0) yield chunk;
}

function trashSessionFiles(paths: readonly string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		const child = spawn("trash", ["--", ...paths], { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (text: string) => {
			stderr = (stderr + text).slice(0, 200);
		});
		child.on("error", (error) => resolve(error.message.slice(0, 200)));
		child.on("close", (code, signal) => {
			resolve(code === 0 ? undefined : stderr.trim().split("\n")[0] || `trash exited with ${signal ?? code}`);
		});
	});
}
