import { type HostRelay, type RelayFrame, startHostRelay } from "../src/core/host-relay.ts";

export interface RelayEnd {
	controlDbPath: string;
	host: string;
}

export interface RelayPairOptions {
	pollMs?: number;
	/** Lose the hub's acknowledgements, as a link that drops before they arrive. */
	dropHubAcks?: boolean;
	onError?: (error: Error) => void;
}

/**
 * Joins a spoke's and the hub's control DBs as `pi server` does over a hub link. Frames pass through JSON and
 * arrive asynchronously, as on the wire. Returns the function that ends the link.
 */
export function pairHostRelays(spoke: RelayEnd, hub: RelayEnd, options: RelayPairOptions = {}): () => void {
	const ends: { spoke?: HostRelay; hub?: HostRelay } = {};
	const wire = (to: "spoke" | "hub", drop: boolean) => (frame: RelayFrame) => {
		if (drop && frame.type === "ack") return;
		const text = JSON.stringify(frame);
		setImmediate(() => ends[to]?.receive(JSON.parse(text)));
	};
	const common = { pollMs: options.pollMs ?? 20, onError: options.onError };
	ends.spoke = startHostRelay({ ...common, ...spoke, peer: hub.host, role: "spoke", send: wire("hub", false) });
	ends.hub = startHostRelay({
		...common,
		...hub,
		peer: spoke.host,
		role: "hub",
		send: wire("spoke", options.dropHubAcks ?? false),
	});
	return () => {
		ends.spoke?.stop();
		ends.hub?.stop();
		ends.spoke = undefined;
		ends.hub = undefined;
	};
}
