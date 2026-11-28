import { type HostRelay, startHostRelay } from "../core/host-relay.ts";
import type { RelayRole } from "../core/host-relay-store.ts";
import { getControlDbPath } from "../core/session-control-db.ts";
import { serverHostId } from "./server-wire.ts";

type Frame = Record<string, unknown>;

/**
 * Cross-host mailbox and channel delivery over a hub link, as `{ type: "relay", frame }` link frames that belong
 * to no client. `peer` is the host at the other end: the spoke's host ID on the hub, the hub's on a spoke.
 */
export function startLinkRelay(role: RelayRole, peer: string, write: (frame: Frame) => void): HostRelay {
	const relay = startHostRelay({
		controlDbPath: getControlDbPath(),
		host: serverHostId(),
		peer,
		role,
		send: (frame) => write({ type: "relay", frame }),
	});
	return { receive: (frame) => relay.receive((frame as Frame).frame), stop: relay.stop };
}
