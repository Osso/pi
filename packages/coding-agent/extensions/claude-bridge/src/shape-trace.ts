import { randomUUID } from "node:crypto";
import { closeSync, fchmodSync, fstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../../src/config.ts";

type PiPhase = "session_start" | "turn_reset" | "pi_tool_boundary" | "pi_final" | "discarded";
type BlockType = "thinking" | "text" | "tool_use" | "redacted_thinking" | "toolCall" | "other";

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function validId(value: unknown, prefix: "msg_" | "toolu_"): string | undefined {
	return typeof value === "string" &&
		value.length <= 128 &&
		value.startsWith(prefix) &&
		/^[A-Za-z0-9_-]+$/.test(value) &&
		value.length > prefix.length
		? value
		: undefined;
}

function blockType(value: unknown): BlockType {
	switch (value) {
		case "thinking":
		case "text":
		case "tool_use":
		case "redacted_thinking":
		case "toolCall":
			return value;
		default:
			return "other";
	}
}

function project(content: unknown, toolType: "tool_use" | "toolCall") {
	const blockTypes: BlockType[] = [];
	const toolIds: string[] = [];
	if (Array.isArray(content)) {
		for (const value of content) {
			const block = object(value);
			const type = blockType(block.type);
			blockTypes.push(type);
			const id = type === toolType ? validId(block.id, "toolu_") : undefined;
			if (id) toolIds.push(id);
		}
	}
	return { blockTypes, toolIds };
}

function reportIo(error: unknown): void {
	const code = object(error).code;
	console.warn(
		`[claude-bridge shapes] I/O ${typeof code === "string" && /^E[A-Z0-9_]{1,40}$/.test(code) ? code : "UNKNOWN"}`,
	);
}

export class ShapeTrace {
	private readonly traceId = randomUUID();
	private readonly piSessionId: string | undefined;
	private readonly path: string;
	private readonly maxBytes: number;
	private capped = false;
	private sdkMessageId: string | undefined;
	private blockTypes: BlockType[] = [];
	private toolIds: string[] = [];

	constructor(piSessionId: string | null, options?: { path?: string; maxBytes?: number }) {
		this.piSessionId =
			typeof piSessionId === "string" &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(piSessionId)
				? piSessionId
				: undefined;
		this.path = options?.path ?? join(getAgentDir(), "claude-bridge-shapes.jsonl");
		this.maxBytes = options?.maxBytes ?? 4 * 1024 * 1024;
	}

	recordSdk(message: unknown): void {
		const sdk = object(message);
		if (sdk.type === "assistant") {
			const assistant = object(sdk.message);
			const shape = project(assistant.content, "tool_use");
			this.append("sdk", "assistant", validId(assistant.id, "msg_"), shape.blockTypes, shape.toolIds);
			return;
		}
		if (sdk.type !== "stream_event") return;
		const event = object(sdk.event);
		switch (event.type) {
			case "message_start":
				this.sdkMessageId = validId(object(event.message).id, "msg_");
				this.blockTypes = [];
				this.toolIds = [];
				break;
			case "content_block_start": {
				const shape = project([event.content_block], "tool_use");
				this.blockTypes.push(...shape.blockTypes);
				this.toolIds.push(...shape.toolIds);
				break;
			}
			case "message_stop":
				break;
			default:
				return;
		}
		this.append("sdk", event.type, this.sdkMessageId, this.blockTypes, this.toolIds);
	}

	recordPi(phase: PiPhase, messageOrContent: unknown, sdkMessageId?: string): void {
		const content = Array.isArray(messageOrContent) ? messageOrContent : object(messageOrContent).content;
		const shape = project(content, "toolCall");
		this.append("pi", phase, validId(sdkMessageId, "msg_"), shape.blockTypes, shape.toolIds);
	}

	private append(
		source: "sdk" | "pi",
		phase: string,
		sdkMessageId: string | undefined,
		blockTypes: BlockType[],
		toolIds: string[],
	): void {
		if (this.capped) return;
		const line = `${JSON.stringify({
			timestamp: new Date().toISOString(),
			pid: process.pid,
			traceId: this.traceId,
			piSessionId: this.piSessionId,
			source,
			phase,
			sdkMessageId,
			blockTypes,
			...(source === "sdk" ? { toolIds } : { toolCallIds: toolIds }),
		})}\n`;
		let descriptor: number | undefined;
		try {
			mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
			descriptor = openSync(this.path, "a", 0o600);
			fchmodSync(descriptor, 0o600);
			if (fstatSync(descriptor).size + Buffer.byteLength(line) > this.maxBytes) {
				this.capped = true;
				console.warn("[claude-bridge shapes] file size cap reached");
				return;
			}
			writeFileSync(descriptor, line);
		} catch (error) {
			reportIo(error);
		} finally {
			if (descriptor !== undefined) {
				try {
					closeSync(descriptor);
				} catch (error) {
					reportIo(error);
				}
			}
		}
	}
}
