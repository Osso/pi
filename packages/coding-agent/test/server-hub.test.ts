import { describe, expect, it } from "vitest";
import { ServerHub } from "../src/cli/server-hub.ts";
import { reconnectDelay } from "../src/cli/server-spoke-link.ts";

type Frame = Record<string, unknown>;

function spoke(hub: ServerHub, hostId: string) {
	const sent: Frame[] = [];
	const link = hub.register(hostId, `${hostId}-instance`, (frame) => sent.push(frame));
	if (!link) throw new Error(`register ${hostId} refused`);
	return { link, sent };
}

describe("ServerHub", () => {
	it("remaps request IDs per link and routes replies and events back to the asking client, tagged", () => {
		const hub = new ServerHub("agent-server");
		const { link, sent } = spoke(hub, "travel-laptop");
		const received: Frame[] = [];
		const client = hub.addClient((frame) => received.push(frame));
		expect(hub.forward(client, { id: "c-1", type: "attach_session", hostId: "travel-laptop", sessionId: "s1" })).toBe(
			true,
		);
		const forwarded = sent.at(-1);
		expect(forwarded).toEqual({ id: "hub-3", type: "attach_session", sessionId: "s1", client: client.id });
		hub.accept(link, { type: "response", id: "hub-3", command: "attach_session", success: true, data: {} });
		hub.accept(link, { type: "session_event", sessionId: "s1", sequence: 1, client: client.id });
		expect(received).toEqual([
			{ type: "response", id: "c-1", command: "attach_session", success: true, data: {}, hostId: "travel-laptop" },
			{ type: "session_event", sessionId: "s1", sequence: 1, hostId: "travel-laptop" },
		]);
	});

	it("keeps the spoke snapshot from events, marks it stale offline, and refuses a duplicate live link", () => {
		const hub = new ServerHub("agent-server");
		const events: Frame[] = [];
		hub.addListener((frame) => events.push(frame));
		const { link, sent } = spoke(hub, "travel-laptop");
		expect(sent.map((frame) => frame.type)).toEqual(["list_sessions", "list_questions"]);
		hub.accept(link, {
			type: "response",
			id: sent[0]?.id,
			command: "list_sessions",
			success: true,
			data: { sessions: [{ sessionId: "s1", status: "idle" }] },
		});
		hub.accept(link, {
			type: "question_updated",
			client: "hub",
			question: { questionId: "q1", state: "pending" },
		});
		expect(hub.cachedSessions()).toEqual([
			{ sessionId: "s1", status: "idle", hostId: "travel-laptop", stale: false },
		]);
		expect(hub.cachedQuestions()).toEqual([
			{ questionId: "q1", state: "pending", hostId: "travel-laptop", stale: false },
		]);
		expect(hub.register("travel-laptop", "other", () => {})).toBeUndefined();

		hub.disconnect(link);
		expect(hub.machines()).toEqual([
			expect.objectContaining({ hostId: "agent-server", status: "online" }),
			{ hostId: "travel-laptop", status: "offline", lastSeenAt: expect.any(String) },
		]);
		expect(hub.cachedSessions()).toEqual([{ sessionId: "s1", status: "idle", hostId: "travel-laptop", stale: true }]);
		expect(events).toContainEqual({
			type: "machine_updated",
			machine: { hostId: "travel-laptop", status: "offline", lastSeenAt: expect.any(String) },
		});

		const again = spoke(hub, "travel-laptop");
		expect(hub.cachedSessions()[0]).toMatchObject({ sessionId: "s1", stale: false });
		hub.accept(again.link, {
			type: "question_updated",
			client: "hub",
			question: { questionId: "q1", state: "answered" },
		});
		expect(hub.cachedQuestions()).toEqual([]);
	});

	it("fails pending forwarded requests when the spoke disconnects", () => {
		const hub = new ServerHub("agent-server");
		const { link } = spoke(hub, "aso");
		const received: Frame[] = [];
		const client = hub.addClient((frame) => received.push(frame));
		hub.forward(client, { id: "c-9", type: "start_session", hostId: "aso", cwd: "/tmp" });
		hub.disconnect(link);
		expect(received).toEqual([
			expect.objectContaining({
				id: "c-9",
				success: false,
				hostId: "aso",
				error: expect.objectContaining({ code: "machine_offline" }),
			}),
		]);
		expect(hub.forward(client, { id: "c-10", type: "list_sessions", hostId: "aso" })).toBe(false);
	});
});

describe("reconnectDelay", () => {
	it("doubles from 1 s with jitter and caps at 30 s", () => {
		expect([0, 1, 2, 10].map((attempt) => reconnectDelay(attempt, () => 1))).toEqual([1_000, 2_000, 4_000, 30_000]);
		expect(reconnectDelay(0, () => 0)).toBe(500);
	});
});
