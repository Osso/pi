import { hostname } from "node:os";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
	ackRelayChannel,
	ackRelayMailbox,
	importRelayChannel,
	importRelayMailbox,
	nextRelayChannel,
	nextRelayMailbox,
	nullableText,
	type RelayChannel,
	type RelayMailbox,
	requireText,
} from "./host-relay-store.ts";
import { getControlDbPath } from "./session-control-db.ts";

export interface HostRelayOptions {
	controlDbPath: string;
	input: Readable;
	output: Writable;
	host?: string;
	pollMs?: number;
	signal?: AbortSignal;
}

type RelayAck = { type: "ack"; kind: "mailbox" | "channel"; id: number };
type RelayFrame = RelayMailbox | RelayChannel | RelayAck | { type: "hello"; host: string };

function positiveInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		throw new Error("Invalid relay sequence/id");
	return value;
}
function parseFrame(line: string): RelayFrame {
	const value: unknown = JSON.parse(line);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid relay frame");
	const frame = value as Record<string, unknown>;
	switch (frame.type) {
		case "hello":
			return { type: "hello", host: requireText(frame.host, "host") };
		case "ack": {
			if (frame.kind !== "mailbox" && frame.kind !== "channel") throw new Error("Invalid relay ack kind");
			return { type: "ack", kind: frame.kind, id: positiveInteger(frame.id) };
		}
		case "mailbox": {
			if (!frame.data || typeof frame.data !== "object" || Array.isArray(frame.data))
				throw new Error("Invalid relay mailbox data");
			return {
				type: "mailbox",
				seq: positiveInteger(frame.seq),
				sessionPath: requireText(frame.sessionPath, "sessionPath"),
				messageId: requireText(frame.messageId, "messageId"),
				data: frame.data as Record<string, unknown>,
			};
		}
		case "channel":
			return {
				type: "channel",
				originHost: requireText(frame.originHost, "originHost"),
				originId: positiveInteger(frame.originId),
				senderSessionId: requireText(frame.senderSessionId, "senderSessionId"),
				senderAgentId: nullableText(frame.senderAgentId, "senderAgentId"),
				body: requireText(frame.body, "body"),
				createdAt: requireText(frame.createdAt, "createdAt"),
			};
		default:
			throw new Error("Unknown relay frame type");
	}
}

/** One mailbox and one channel in flight; retries preserve persisted sequence and channel origin. */
export function runHostRelay(options: HostRelayOptions): Promise<void> {
	const host = options.host ?? hostname();
	const lines = createInterface({ input: options.input, crlfDelay: Infinity });
	return new Promise((resolve, reject) => {
		let peer: string | undefined;
		let mailbox: RelayMailbox | undefined;
		let channel: RelayChannel | undefined;
		let settled = false;
		const send = (frame: RelayFrame) => {
			options.output.write(`${JSON.stringify(frame)}\n`);
		};
		const scan = () => {
			if (!peer || options.output.writableNeedDrain) return;
			mailbox = nextRelayMailbox(options.controlDbPath, peer);
			channel = nextRelayChannel(options.controlDbPath, peer, host);
			if (mailbox) send(mailbox);
			if (channel) send(channel);
		};
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearInterval(timer);
			options.signal?.removeEventListener("abort", stop);
			options.input.off("error", fail);
			options.output.off("error", fail);
			lines.removeAllListeners();
			lines.close();
			if (error) reject(error);
			else resolve();
		};
		const fail = (error: Error) => finish(error);
		const stop = () => finish();
		const guardedScan = () => {
			try {
				scan();
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		};
		const timer = setInterval(guardedScan, options.pollMs ?? 2000);
		options.input.on("error", fail);
		options.output.on("error", fail);
		options.signal?.addEventListener("abort", stop, { once: true });
		lines.on("close", stop);
		lines.on("line", (line) => {
			try {
				const frame = parseFrame(line);
				if (frame.type === "hello") {
					if (peer || frame.host === host) throw new Error("Invalid relay peer hello");
					peer = frame.host;
					scan();
					return;
				}
				if (!peer) throw new Error("Relay hello required before messages");
				if (frame.type === "mailbox") {
					if (frame.data.recipientHost !== host || frame.data.relaySeq !== frame.seq)
						throw new Error("Relay mailbox route/sequence mismatch");
					importRelayMailbox(options.controlDbPath, peer, frame);
					send({ type: "ack", kind: "mailbox", id: frame.seq });
				} else if (frame.type === "channel") {
					if (frame.originHost !== peer) throw new Error("Relay channel origin mismatch");
					importRelayChannel(options.controlDbPath, frame);
					send({ type: "ack", kind: "channel", id: frame.originId });
				} else if (frame.kind === "mailbox" && mailbox?.seq === frame.id) {
					ackRelayMailbox(options.controlDbPath, peer, mailbox);
					mailbox = undefined;
				} else if (frame.kind === "channel" && channel?.originId === frame.id) {
					ackRelayChannel(options.controlDbPath, peer, frame.id);
					channel = undefined;
				}
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
		if (options.signal?.aborted) stop();
		else send({ type: "hello", host });
	});
}

export async function runRelayServe(): Promise<void> {
	await runHostRelay({ controlDbPath: getControlDbPath(), input: process.stdin, output: process.stdout });
}
