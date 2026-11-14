import type { ImageContent } from "@earendil-works/pi-ai";
import type { Args } from "./args.ts";

export interface InitialMessageInput {
	parsed: Args;
	fileText?: string;
	fileImages?: ImageContent[];
	stdinContent?: string;
}

export interface InitialMessageResult {
	initialMessage?: string;
	initialImages?: ImageContent[];
}

/**
 * Combine stdin content, @file text, and the first CLI message into a single
 * initial prompt for non-interactive mode.
 */
export function buildInitialMessage({
	parsed,
	fileText,
	fileImages,
	stdinContent,
}: InitialMessageInput): InitialMessageResult {
	const parts: string[] = [];
	if (stdinContent !== undefined) {
		parts.push(stdinContent);
	}
	if (fileText) {
		parts.push(fileText);
	}

	if (parsed.messages.length > 0) {
		parts.push(String(parsed.messages[0]));
		parsed.messages.shift();
	}

	return {
		// Piped stdin arrives trimmed, so add a line break between parts that lack one.
		initialMessage:
			parts.length > 0
				? parts.reduce((text, part) => (text === "" || text.endsWith("\n") ? text + part : `${text}\n${part}`))
				: undefined,
		initialImages: fileImages && fileImages.length > 0 ? fileImages : undefined,
	};
}
