import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ackRelayChannel, importRelayChannel, nextRelayChannel } from "../src/core/host-relay-store.ts";
import {
	advanceSharedChannelCursor,
	hasPendingRuntimeCoordinationMessage,
	initializeSharedChannelCursorAtTail,
	listSharedChannelMessagesAfter,
	postSharedChannelMessage,
	retainControlDbConnection,
} from "../src/core/session-control-db.ts";

const start = Date.parse("2026-10-08T12:00:00.000Z");
const day = 24 * 60 * 60 * 1000;
const sender = { sessionId: "channel-sender", agentId: null };
const reader = { sessionId: "channel-reader", agentId: null };
let directory: string;
let path: string;
const releases: (() => void)[] = [];

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(start);
	directory = mkdtempSync(join(tmpdir(), "pi-channel-retention-"));
	path = join(directory, "control.sqlite");
});

afterEach(() => {
	for (const release of releases.splice(0)) release();
	vi.useRealTimers();
	rmSync(directory, { recursive: true, force: true });
});

const post = (body: string) => postSharedChannelMessage(path, { sender, body });
const bodies = () => listSharedChannelMessagesAfter(path, 0, 100).map((message) => message.body);

it("deletes channel messages 24h after creation while cursors and relay replication keep working", () => {
	advanceSharedChannelCursor(path, reader, 0);
	const first = post("first");
	post("second");
	expect(nextRelayChannel(path, "peer", "aso")).toBeUndefined();
	releases.push(retainControlDbConnection(path));

	vi.setSystemTime(start + day - 60_000);
	const fresh = post("fresh");
	vi.advanceTimersByTime(60_000);
	expect(bodies()).toEqual(["fresh"]);
	expect(nextRelayChannel(path, "peer", "aso")?.originId).toBe(fresh);
	ackRelayChannel(path, "peer", fresh);
	advanceSharedChannelCursor(path, reader, fresh);

	vi.advanceTimersByTime(day);
	expect(bodies()).toEqual([]);
	const lateJoiner = { sessionId: "late-joiner", agentId: null };
	expect(initializeSharedChannelCursorAtTail(path, lateJoiner)).toBe(0);

	const after = post("after expiry");
	expect(after).toBeGreaterThan(fresh);
	expect(after).toBeGreaterThan(first);
	expect(listSharedChannelMessagesAfter(path, fresh).map((message) => message.body)).toEqual(["after expiry"]);
	expect(hasPendingRuntimeCoordinationMessage(path, reader)).toBe(true);
	expect(listSharedChannelMessagesAfter(path, 0).map((message) => message.body)).toEqual(["after expiry"]);
	expect(nextRelayChannel(path, "peer", "aso")?.originId).toBe(after);
});

it("startup removes channel messages already older than 24h", () => {
	post("stale");
	vi.setSystemTime(start + day);
	post("fresh");
	releases.push(retainControlDbConnection(path));
	expect(bodies()).toEqual(["fresh"]);
});

it("a relay retry arriving after expiry does not re-deliver the deleted message", () => {
	releases.push(retainControlDbConnection(path));
	const frame = {
		type: "channel" as const,
		originHost: "agent-server",
		originId: 42,
		senderSessionId: "remote",
		senderAgentId: null,
		body: "from peer",
		createdAt: new Date(start).toISOString(),
	};
	importRelayChannel(path, frame);
	const imported = listSharedChannelMessagesAfter(path, 0)[0].id;
	advanceSharedChannelCursor(path, reader, imported);
	vi.advanceTimersByTime(day);
	expect(bodies()).toEqual([]);

	importRelayChannel(path, frame);
	importRelayChannel(path, { ...frame, originId: 43, createdAt: "not a date" });
	expect(bodies()).toEqual([]);
	expect(hasPendingRuntimeCoordinationMessage(path, reader)).toBe(false);
});
