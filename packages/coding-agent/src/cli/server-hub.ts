import { serverHostId } from "./server-wire.ts";

type Frame = Record<string, unknown>;

/** A connection on the hub whose frames can be forwarded to spokes. */
export type HubClient = { id: string; send: (frame: Frame) => void };

type Pending = { requestId: unknown; command: string; client?: HubClient };

export type HubLink = {
	hostId: string;
	serverInstanceId: string;
	write: (frame: Frame) => void;
	online: boolean;
	lastSeenAt: string;
	nextId: number;
	pending: Map<string, Pending>;
	sessions: Map<string, Frame>;
	questions: Map<string, Frame>;
};

/** The hub's own subscription on every spoke; it keeps the aggregate snapshot current. */
const HUB_CLIENT = "hub";
/** Inventory events reach hub clients once, through the hub's own subscription, not per forwarded list request. */
const INVENTORY_EVENTS = new Set(["session_updated", "session_removed", "question_updated"]);

function entriesById(entries: unknown, key: string): Map<string, Frame> {
	const list = Array.isArray(entries) ? (entries as Frame[]) : [];
	return new Map(list.map((entry) => [String(entry[key]), entry]));
}

/** Adds hostId to each entry of a list_sessions or list_questions result, as on every hub list. */
function tagListEntries(data: unknown, hostId: string): unknown {
	if (!data || typeof data !== "object") return data;
	const tagged: Frame = { ...(data as Frame) };
	for (const key of ["sessions", "questions"]) {
		const entries = tagged[key];
		if (Array.isArray(entries)) tagged[key] = entries.map((entry: Frame) => ({ ...entry, hostId }));
	}
	return tagged;
}

/** Tracks spoke links, remaps forwarded request IDs per link, and keeps each spoke's last snapshot. */
export class ServerHub {
	readonly hostId: string;
	private readonly links = new Map<string, HubLink>();
	private readonly clients = new Map<string, HubClient>();
	private readonly listeners = new Set<(frame: Frame) => void>();
	private nextClientNumber = 0;

	constructor(hostId = serverHostId()) {
		this.hostId = hostId;
	}

	/** Receives hub-wide events: machine_updated, snapshot changes from spokes, and resync_required. */
	addListener(listener: (frame: Frame) => void): void {
		this.listeners.add(listener);
	}

	addClient(send: (frame: Frame) => void): HubClient {
		const client = { id: `c${++this.nextClientNumber}`, send };
		this.clients.set(client.id, client);
		return client;
	}

	/** Releases the client's per-link state on every spoke (attachments, control, subscriptions). */
	removeClient(client: HubClient): void {
		this.clients.delete(client.id);
		for (const link of this.links.values()) {
			for (const [id, pending] of link.pending) if (pending.client === client) link.pending.delete(id);
			if (link.online) link.write({ type: "client_closed", client: client.id });
		}
	}

	/** Registers a spoke after link_hello; refuses a second link while the first is still online. */
	register(hostId: string, serverInstanceId: string, write: (frame: Frame) => void): HubLink | undefined {
		const previous = this.links.get(hostId);
		if (previous?.online) return undefined;
		const link: HubLink = {
			hostId,
			serverInstanceId,
			write,
			online: true,
			lastSeenAt: new Date().toISOString(),
			nextId: 0,
			pending: new Map(),
			sessions: previous?.sessions ?? new Map(),
			questions: previous?.questions ?? new Map(),
		};
		this.links.set(hostId, link);
		this.requestSnapshot(link, { type: "list_sessions", includeEnded: true });
		this.requestSnapshot(link, { type: "list_questions" });
		this.publishMachine(link);
		return link;
	}

	disconnect(link: HubLink): void {
		if (this.links.get(link.hostId) !== link || !link.online) return;
		link.online = false;
		link.lastSeenAt = new Date().toISOString();
		for (const pending of link.pending.values())
			pending.client?.send({
				type: "response",
				id: pending.requestId,
				command: pending.command,
				success: false,
				hostId: link.hostId,
				error: { code: "machine_offline", message: `Machine ${link.hostId} disconnected` },
			});
		link.pending.clear();
		this.publishMachine(link);
	}

	machines(): Frame[] {
		return [
			{ hostId: this.hostId, status: "online", lastSeenAt: new Date().toISOString() },
			...[...this.links.values()].map((link) => this.machine(link)),
		];
	}

	/** Forwards a client frame to the spoke named by its hostId; false when that spoke is not online. */
	forward(client: HubClient, frame: Frame): boolean {
		const link = this.links.get(String(frame.hostId));
		if (!link?.online) return false;
		const { hostId: _hostId, id: requestId, ...body } = frame;
		const id = this.track(link, { requestId, command: String(frame.type), client });
		link.write({ ...body, id, client: client.id });
		return true;
	}

	accept(link: HubLink, frame: Frame): void {
		link.lastSeenAt = new Date().toISOString();
		const { client: target, ...body } = frame;
		if (body.type === "response") this.acceptResponse(link, body);
		else if (target === HUB_CLIENT) this.applySnapshotEvent(link, body);
		else if (typeof target === "string" && !INVENTORY_EVENTS.has(String(body.type)))
			this.clients.get(target)?.send({ ...body, hostId: link.hostId });
	}

	/** Last known sessions of every spoke, tagged with hostId; `stale` while the spoke is offline. */
	cachedSessions(): Frame[] {
		return this.cached((link) => link.sessions);
	}

	cachedQuestions(): Frame[] {
		return this.cached((link) => link.questions);
	}

	private cached(select: (link: HubLink) => Map<string, Frame>): Frame[] {
		return [...this.links.values()].flatMap((link) =>
			[...select(link).values()].map((entry) => ({ ...entry, hostId: link.hostId, stale: !link.online })),
		);
	}

	private track(link: HubLink, pending: Pending): string {
		const id = `hub-${++link.nextId}`;
		link.pending.set(id, pending);
		return id;
	}

	private requestSnapshot(link: HubLink, frame: Frame): void {
		const id = this.track(link, { requestId: undefined, command: String(frame.type) });
		link.write({ ...frame, id, client: HUB_CLIENT });
	}

	private acceptResponse(link: HubLink, frame: Frame): void {
		const pending = link.pending.get(String(frame.id));
		if (!pending) return;
		link.pending.delete(String(frame.id));
		if (pending.client) {
			const data = frame.success === true ? tagListEntries(frame.data, link.hostId) : frame.data;
			pending.client.send({ ...frame, data, id: pending.requestId, hostId: link.hostId });
			return;
		}
		if (frame.success !== true) {
			console.error(`pi server hub: ${pending.command} on ${link.hostId} failed: ${JSON.stringify(frame.error)}`);
			return;
		}
		const data = (frame.data ?? {}) as Frame;
		const scope = pending.command === "list_sessions" ? "sessions" : "questions";
		if (scope === "sessions") link.sessions = entriesById(data.sessions, "sessionId");
		else link.questions = entriesById(data.questions, "questionId");
		this.publish({ type: "resync_required", scope, hostId: link.hostId });
	}

	private applySnapshotEvent(link: HubLink, frame: Frame): void {
		const session = frame.session as Frame | undefined;
		const question = frame.question as Frame | undefined;
		if (frame.type === "session_updated" && session) link.sessions.set(String(session.sessionId), session);
		if (frame.type === "session_removed") link.sessions.delete(String(frame.sessionId));
		if (frame.type === "question_updated" && question) {
			// The snapshot mirrors list_questions, which holds pending questions only.
			if (question.state === "pending") link.questions.set(String(question.questionId), question);
			else link.questions.delete(String(question.questionId));
		}
		this.publish({ ...frame, hostId: link.hostId });
	}

	private machine(link: HubLink): Frame {
		return {
			hostId: link.hostId,
			status: link.online ? "online" : "offline",
			lastSeenAt: link.lastSeenAt,
			...(link.online ? { serverInstanceId: link.serverInstanceId } : {}),
		};
	}

	private publishMachine(link: HubLink): void {
		this.publish({ type: "machine_updated", machine: this.machine(link) });
	}

	private publish(frame: Frame): void {
		for (const listener of this.listeners) listener(frame);
	}
}
