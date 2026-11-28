import {
	ackRelayChannel,
	ackRelayMailbox,
	importRelayChannel,
	importRelayMailbox,
	nextRelayChannel,
	nextRelayMailbox,
	nullableText,
	type RelayChannel,
	type RelayChannelFrame,
	type RelayMailbox,
	type RelayRole,
	requireText,
} from "./host-relay-store.ts";

/**
 * Cross-host mailbox and channel delivery over one pi server hub link. Each end knows its peer from the link
 * handshake. A spoke sends every message for another host to the hub and only its own channel posts; the hub
 * sends a spoke the messages for that spoke and every channel post not from it, so spokes reach each other
 * through the hub.
 */
export interface HostRelayOptions {
	controlDbPath: string;
	/** This server's host ID. */
	host: string;
	/** The host at the other end of the link. */
	peer: string;
	role: RelayRole;
	send: (frame: RelayFrame) => void;
	pollMs?: number;
	/** Pause after a failure, so a bad stored row or frame is not retried and logged every poll. */
	errorPauseMs?: number;
	onError?: (error: Error) => void;
}

export interface HostRelay {
	receive: (frame: unknown) => void;
	stop: () => void;
}

type RelayAck = { type: "ack"; kind: "mailbox" | "channel"; id: number };
export type RelayFrame = RelayMailbox | RelayChannelFrame | RelayAck;

function positiveInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		throw new Error("Invalid relay sequence/id");
	return value;
}

function parseFrame(value: unknown): RelayFrame {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid relay frame");
	const frame = value as Record<string, unknown>;
	switch (frame.type) {
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

/** Names the relay step that failed, so a log line identifies the operation. */
function relayStepError(step: string, error: unknown): Error {
	return new Error(`relay ${step}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

/** Checks that a received frame may come from this peer. */
function checkRoute(frame: RelayMailbox | RelayChannelFrame, options: HostRelayOptions): void {
	const { host, peer, role } = options;
	if (frame.type === "mailbox") {
		const target = frame.data.recipientHost;
		// The hub forwards a message for another spoke; a spoke only receives its own.
		const routed = role === "hub" ? typeof target === "string" && target !== peer : target === host;
		if (!routed || frame.data.relaySeq !== frame.seq) throw new Error("Relay mailbox route/sequence mismatch");
	} else {
		const origin = role === "hub" ? frame.originHost === peer : frame.originHost !== host;
		if (!origin) throw new Error("Relay channel origin mismatch");
	}
}

/** One mailbox and one channel entry in flight, resent each poll until acknowledged. */
export function startHostRelay(options: HostRelayOptions): HostRelay {
	const { controlDbPath, host, peer, role } = options;
	const report = options.onError ?? ((error: Error) => console.error(`pi server relay ${peer}: ${error.message}`));
	let mailbox: RelayMailbox | undefined;
	let channel: RelayChannel | undefined;
	let pausedUntil = 0;
	let stopped = false;
	const fail = (error: Error) => {
		mailbox = undefined;
		channel = undefined;
		pausedUntil = Date.now() + (options.errorPauseMs ?? 30_000);
		report(error);
	};
	const scan = () => {
		if (stopped || Date.now() < pausedUntil) return;
		try {
			mailbox = nextRelayMailbox(controlDbPath, peer, role === "spoke" ? host : undefined);
			channel = nextRelayChannel(controlDbPath, peer, host, role);
			if (mailbox) options.send(mailbox);
			if (channel) {
				const { cursor: _cursor, ...wire } = channel;
				options.send(wire);
			}
		} catch (error) {
			fail(relayStepError("scan", error));
		}
	};
	const receive = (value: unknown) => {
		if (stopped || Date.now() < pausedUntil) return;
		let step = "frame parse";
		try {
			const frame = parseFrame(value);
			step = frame.type === "ack" ? `${frame.kind} ack` : `${frame.type} frame`;
			if (frame.type === "mailbox") {
				checkRoute(frame, options);
				importRelayMailbox(controlDbPath, peer, frame, host);
				options.send({ type: "ack", kind: "mailbox", id: frame.seq });
			} else if (frame.type === "channel") {
				checkRoute(frame, options);
				importRelayChannel(controlDbPath, frame);
				options.send({ type: "ack", kind: "channel", id: frame.originId });
			} else if (frame.kind === "mailbox" && mailbox?.seq === frame.id) {
				ackRelayMailbox(controlDbPath, mailbox);
				mailbox = undefined;
			} else if (frame.kind === "channel" && channel?.originId === frame.id) {
				ackRelayChannel(controlDbPath, peer, channel.cursor);
				channel = undefined;
			}
		} catch (error) {
			fail(relayStepError(step, error));
		}
	};
	const timer = setInterval(scan, options.pollMs ?? 2000);
	scan();
	return {
		receive,
		stop: () => {
			stopped = true;
			clearInterval(timer);
		},
	};
}
