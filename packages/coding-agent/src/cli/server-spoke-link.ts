import { type ChildProcess, spawn } from "node:child_process";
import { errorMessage, readFrames, writeFrame } from "./server-wire.ts";

type Frame = Record<string, unknown>;

export type SpokeLinkHandlers<C> = {
	/** Creates the local client that stands for one hub connection (or for the hub's own subscription). */
	createClient: (send: (frame: unknown) => void) => C;
	dropClient: (client: C) => void;
	handle: (frame: Frame, client: C) => void;
	/** The hub accepted the link: `send` writes frames that belong to no client (relay traffic). */
	opened: (hubHostId: string, send: (frame: Frame) => void) => void;
	/** A frame for no client: relay traffic from the hub. */
	linkFrame: (frame: Frame) => void;
	closed: () => void;
};

const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/** Delay before reconnect attempt `attempt` (0-based): exponential with full jitter, capped at 30 s. */
export function reconnectDelay(attempt: number, random = Math.random): number {
	const ceiling = Math.min(INITIAL_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
	return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/**
 * Keeps one outbound JSONL link to the hub (`ssh -T <hub> pi server --link` by default) and reconnects with
 * backoff after it exits. Frames from the hub carry `client`: the hub connection they belong to; each one gets
 * its own local client so attachments, control and subscriptions stay per hub connection.
 */
export function startSpokeLink<C>(command: string[], hello: Frame, handlers: SpokeLinkHandlers<C>): () => void {
	const executable = command[0];
	if (!executable) throw new Error("server.hubCommand must start with an executable");
	let stopped = false;
	let child: ChildProcess | undefined;
	let timer: NodeJS.Timeout | undefined;
	let attempt = 0;

	const connect = () => {
		const current = spawn(executable, command.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
		child = current;
		const clients = new Map<string, C>();
		const write = (frame: Frame) => {
			if (current.stdin) writeFrame(current.stdin, frame);
		};
		const clientFor = (id: string): C => {
			const existing = clients.get(id);
			if (existing) return existing;
			const created = handlers.createClient((frame) => write({ ...(frame as Frame), client: id }));
			clients.set(id, created);
			return created;
		};
		const onFrame = (frame: Frame) => {
			const { client: id, ...body } = frame;
			if (body.type === "link_hello_ack") {
				attempt = 0;
				handlers.opened(String(body.hostId), write);
			} else if (body.type === "relay") handlers.linkFrame(body);
			else if (body.type === "link_hello_rejected") {
				console.error(`pi server link: hub refused this host: ${JSON.stringify(body.error)}`);
				current.kill("SIGTERM");
			} else if (body.type === "client_closed" && typeof id === "string") {
				const client = clients.get(id);
				clients.delete(id);
				if (client) handlers.dropClient(client);
			} else if (typeof id === "string") handlers.handle(body, clientFor(id));
		};
		if (!current.stdout || !current.stdin) throw new Error("Hub link stdio is not piped");
		readFrames(current.stdout, onFrame, (line) => {
			console.error(`pi server link: invalid frame from hub: ${line.slice(0, 200)}`);
			current.kill("SIGTERM");
		});
		current.stdin.on("error", (error) => console.error(`pi server link: ${errorMessage(error)}`));
		current.once("error", (error) => console.error(`pi server link: ${errorMessage(error)}`));
		current.once("close", () => {
			for (const client of clients.values()) handlers.dropClient(client);
			clients.clear();
			handlers.closed();
			if (child === current) child = undefined;
			if (stopped) return;
			timer = setTimeout(connect, reconnectDelay(attempt));
			attempt += 1;
		});
		write(hello);
	};

	connect();
	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
		child?.kill("SIGTERM");
	};
}
