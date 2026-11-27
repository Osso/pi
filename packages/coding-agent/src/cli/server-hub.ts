import { hostname } from "node:os";

type HubResponse = (frame: Record<string, unknown>) => void;
type HubWriter = (frame: Record<string, unknown>) => void;

type HubLink = {
	hostId: string;
	serverInstanceId: string;
	write: HubWriter;
	alive: () => boolean;
	nextId: number;
	pending: Map<string, { clientId: string; command: string; respond: HubResponse }>;
	sessions: Record<string, unknown>[];
	questions: Record<string, unknown>[];
	lastSeenAt: string;
};

/** Tracks spoke links and remaps their connection-scoped request IDs. */
export class ServerHub {
	private readonly links = new Map<string, HubLink>();
	private readonly listeners = new Set<HubWriter>();
	readonly hostId = hostname();

	addListener(write: HubWriter): () => void {
		this.listeners.add(write);
		return () => this.listeners.delete(write);
	}

	register(hostId: string, serverInstanceId: string, write: HubWriter, alive: () => boolean): boolean {
		const existing = this.links.get(hostId);
		if (existing?.alive()) return false;
		this.links.set(hostId, {
			hostId,
			serverInstanceId,
			write,
			alive,
			nextId: 0,
			pending: new Map(),
			sessions: existing?.sessions ?? [],
			questions: existing?.questions ?? [],
			lastSeenAt: existing?.lastSeenAt ?? new Date().toISOString(),
		});
		this.publishMachine(hostId);
		return true;
	}

	remove(hostId: string): void {
		const link = this.links.get(hostId);
		if (!link || link.alive()) return;
		this.publishMachine(hostId);
	}

	machines(): Record<string, unknown>[] {
		return [
			{ hostId: this.hostId, status: "online", lastSeenAt: new Date().toISOString() },
			...[...this.links.values()].map((link) => ({
				hostId: link.hostId,
				status: link.alive() ? "online" : "offline",
				lastSeenAt: link.lastSeenAt,
				...(link.alive() ? { serverInstanceId: link.serverInstanceId } : {}),
			})),
		];
	}

	forward(hostId: string, frame: Record<string, unknown>, respond: HubResponse): boolean {
		const link = this.links.get(hostId);
		if (!link?.alive()) return false;
		const id = `hub-${++link.nextId}`;
		link.pending.set(id, {
			clientId: String(frame.id ?? ""),
			command: String(frame.type ?? ""),
			respond,
		});
		const { hostId: _hostId, ...forwarded } = frame;
		link.write({ ...forwarded, id });
		return true;
	}

	accept(hostId: string, frame: Record<string, unknown>): void {
		const link = this.links.get(hostId);
		if (!link) return;
		link.lastSeenAt = new Date().toISOString();
		if (frame.type === "response" && typeof frame.id === "string") {
			const pending = link.pending.get(frame.id);
			if (!pending) return;
			link.pending.delete(frame.id);
			if (frame.success === true && pending.command === "list_sessions")
				link.sessions = (
					((frame.data as Record<string, unknown> | undefined)?.sessions as Record<string, unknown>[]) ?? []
				).map((session) => ({ ...session, hostId, stale: false }));
			if (frame.success === true && pending.command === "list_questions")
				link.questions = (
					((frame.data as Record<string, unknown> | undefined)?.questions as Record<string, unknown>[]) ?? []
				).map((question) => ({ ...question, hostId, stale: false }));
			pending.respond({ ...frame, id: pending.clientId, command: pending.command, hostId });
			return;
		}
		const tagged = { ...frame, hostId };
		if (frame.type === "session_updated" && frame.session && typeof frame.session === "object")
			link.sessions = [
				...link.sessions.filter((item) => item.sessionId !== (frame.session as Record<string, unknown>).sessionId),
				{ ...(frame.session as Record<string, unknown>), hostId, stale: false },
			];
		if (frame.type === "question_updated" && frame.question && typeof frame.question === "object")
			link.questions = [
				...link.questions.filter(
					(item) => item.questionId !== (frame.question as Record<string, unknown>).questionId,
				),
				{ ...(frame.question as Record<string, unknown>), hostId, stale: false },
			];
		for (const listener of this.listeners) listener(tagged);
	}

	cachedSessions(): Record<string, unknown>[] {
		return [...this.links.values()].flatMap((link) =>
			link.sessions.map((item) => ({ ...item, stale: !link.alive() })),
		);
	}

	cachedQuestions(): Record<string, unknown>[] {
		return [...this.links.values()].flatMap((link) =>
			link.questions.map((item) => ({ ...item, stale: !link.alive() })),
		);
	}

	private publishMachine(hostId: string): void {
		const machine = this.machines().find((item) => item.hostId === hostId);
		if (machine) for (const listener of this.listeners) listener({ type: "machine_updated", machine });
	}
}
