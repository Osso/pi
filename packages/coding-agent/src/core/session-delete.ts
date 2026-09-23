import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { listSubagentSessionPaths, removeSessionMetadata } from "./session-control-db.ts";

export type SessionDeleteResult = { ok: true; method: "trash" | "unlink" } | { ok: false; error: string };

/**
 * Deletes a session transcript and every child agent transcript recorded under it, moving files to the trash when the
 * `trash` CLI works and deleting them permanently otherwise, then removes their control-DB metadata.
 */
export function deleteSessionTree(sessionPath: string, controlDbPath: string | undefined): SessionDeleteResult {
	const sessionPaths = controlDbPath
		? [...collectChildSessionPaths(controlDbPath, sessionPath), sessionPath]
		: [sessionPath];
	let method: "trash" | "unlink" = "trash";
	for (const path of sessionPaths) {
		const result = deleteSessionFile(path);
		if (!result.ok) return result;
		if (result.method === "unlink") method = "unlink";
		if (controlDbPath) removeSessionMetadata(controlDbPath, path);
	}
	return { ok: true, method };
}

function collectChildSessionPaths(controlDbPath: string, parentSessionPath: string): string[] {
	return listSubagentSessionPaths(controlDbPath, parentSessionPath).flatMap((childPath) => [
		...collectChildSessionPaths(controlDbPath, childPath),
		childPath,
	]);
}

function deleteSessionFile(sessionPath: string): SessionDeleteResult {
	const trashResult = spawnSync("trash", sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath], {
		encoding: "utf-8",
	});
	if (trashResult.status === 0 || !existsSync(sessionPath)) return { ok: true, method: "trash" };
	try {
		unlinkSync(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (error) {
		const unlinkError = error instanceof Error ? error.message : String(error);
		const trashError = [trashResult.error?.message, trashResult.stderr?.trim().split("\n")[0]]
			.filter(Boolean)
			.join(" · ");
		return { ok: false, error: trashError ? `${unlinkError} (trash: ${trashError.slice(0, 200)})` : unlinkError };
	}
}
