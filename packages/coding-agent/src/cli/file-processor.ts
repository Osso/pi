/**
 * Process @file CLI arguments into text content and image attachments
 */

import { access, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { processImage } from "../utils/image-process.ts";
import { detectSupportedImageMimeType } from "../utils/mime.ts";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
}

function exitUnreadableFile(absolutePath: string, error: unknown): never {
	const message = error instanceof Error ? error.message : String(error);
	console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
	process.exit(1);
}

/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		// Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		// Check if file exists
		try {
			await access(absolutePath);
		} catch {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		const stats = await stat(absolutePath);
		if (stats.isDirectory()) {
			console.error(chalk.red(`Error: ${absolutePath} is a directory; @ arguments must be files`));
			process.exit(1);
		}

		// Read once: pipes such as `@<(git diff)` report size 0 and cannot be read twice.
		let content: Buffer;
		try {
			content = await readFile(absolutePath);
		} catch (error: unknown) {
			exitUnreadableFile(absolutePath, error);
		}
		if (content.length === 0) {
			continue;
		}

		const mimeType = detectSupportedImageMimeType(content);
		if (!mimeType) {
			text += `<file name="${absolutePath}">\n${content.toString("utf-8")}\n</file>\n`;
			continue;
		}

		const processed = await processImage(content, mimeType, { autoResizeImages });
		if (!processed.ok) {
			text += `<file name="${absolutePath}">${processed.message}</file>\n`;
			continue;
		}
		images.push({ type: "image", mimeType: processed.mimeType, data: processed.data });
		// Add text reference to image with optional processing hints
		text += `<file name="${absolutePath}">${processed.hints.join("\n")}</file>\n`;
	}

	return { text, images };
}
