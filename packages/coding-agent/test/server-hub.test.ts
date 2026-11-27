import { describe, expect, it } from "vitest";
import { ServerHub } from "../src/cli/server-hub.ts";

describe("ServerHub", () => {
	it("remaps spoke request IDs, tags replies, and retains offline snapshots", () => {
		const hub = new ServerHub();
		const sent: Record<string, unknown>[] = [];
		const events: Record<string, unknown>[] = [];
		let online = true;
		hub.addListener((frame) => events.push(frame));
		expect(
			hub.register(
				"travel-laptop",
				"spoke-1",
				(frame) => sent.push(frame),
				() => online,
			),
		).toBe(true);
		const replies: Record<string, unknown>[] = [];
		expect(
			hub.forward("travel-laptop", { id: "client-1", type: "list_sessions" }, (frame) => replies.push(frame)),
		).toBe(true);
		expect(sent[0]).toMatchObject({ id: "hub-1", type: "list_sessions" });
		hub.accept("travel-laptop", {
			type: "response",
			id: "hub-1",
			command: "list_sessions",
			success: true,
			data: { sessions: [{ sessionId: "session-1" }] },
		});
		expect(replies[0]).toMatchObject({ id: "client-1", hostId: "travel-laptop" });
		expect(hub.cachedSessions()).toEqual([{ sessionId: "session-1", hostId: "travel-laptop", stale: false }]);
		online = false;
		expect(hub.machines()).toContainEqual(expect.objectContaining({ hostId: "travel-laptop", status: "offline" }));
		expect(hub.cachedSessions()).toEqual([{ sessionId: "session-1", hostId: "travel-laptop", stale: true }]);
		expect(events).toContainEqual(expect.objectContaining({ type: "machine_updated" }));
	});
});
