import { unlinkSync } from "node:fs";

export type ClipboardTempFileTracker = {
	track(filePath: string): void;
	cleanupReferencedIn(text: string): void;
	cleanupAll(): void;
};

function removeFile(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		// Temp cleanup is best-effort: the file may already be gone.
	}
}

export function createClipboardTempFileTracker(): ClipboardTempFileTracker {
	const trackedFiles = new Set<string>();

	return {
		track(filePath: string): void {
			trackedFiles.add(filePath);
		},

		cleanupReferencedIn(text: string): void {
			for (const filePath of [...trackedFiles]) {
				if (!text.includes(filePath)) {
					continue;
				}
				removeFile(filePath);
				trackedFiles.delete(filePath);
			}
		},

		cleanupAll(): void {
			for (const filePath of [...trackedFiles]) {
				removeFile(filePath);
				trackedFiles.delete(filePath);
			}
		},
	};
}
