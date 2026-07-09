import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type ArchitectChannelMessage,
	ArchitectObserver,
	type ArchitectSessionSnapshot,
	createArchitectObservation,
	readArchitectSnapshot,
} from "../src/architect/observer.ts";

const session: ArchitectSessionSnapshot = {
	cwd: "/repo",
	goalJson: '{"objective":"Keep tests green"}',
	id: "main-session",
	isSubagent: false,
	name: "main",
};

describe("architect observer", () => {
	it("emits an initial snapshot", () => {
		const observation = createArchitectObservation(undefined, [session], []);

		expect(observation).toMatchObject({ reason: "session_state_changed", sessions: [session] });
	});

	it("ignores non-material session metadata changes", () => {
		const previous = createArchitectObservation(undefined, [session], []);
		if (!previous) throw new Error("expected initial observation");

		expect(createArchitectObservation(previous, [session], [])).toBeUndefined();
	});

	it("emits an observation when an active goal changes", () => {
		const previous = createArchitectObservation(undefined, [session], []);
		if (!previous) throw new Error("expected initial observation");
		const changed = { ...session, goalJson: '{"objective":"Deploy safely"}' };

		expect(createArchitectObservation(previous, [changed], [])).toMatchObject({
			reason: "session_state_changed",
			sessions: [changed],
		});
	});

	it("emits an observation for explicit main-session architect requests", () => {
		const previous = createArchitectObservation(undefined, [session], []);
		if (!previous) throw new Error("expected initial observation");
		const request: ArchitectChannelMessage = {
			body: "Architect: assess goal drift",
			id: 4,
			senderAgentId: null,
			senderSessionId: "other-main",
		};

		expect(createArchitectObservation(previous, [session], [request])).toMatchObject({
			reason: "architect_request",
			requests: [request],
		});
	});

	it("ignores subagent, Architect, and unrelated channel posts", () => {
		const previous = createArchitectObservation(undefined, [session], []);
		if (!previous) throw new Error("expected initial observation");
		const messages: ArchitectChannelMessage[] = [
			{ body: "Architect: ignore this", id: 5, senderAgentId: "agent_1", senderSessionId: "child" },
			{ body: "Architect: this is already known", id: 6, senderAgentId: null, senderSessionId: "architect" },
			{ body: "normal update", id: 7, senderAgentId: null, senderSessionId: "other-main" },
		];

		expect(createArchitectObservation(previous, [session], messages)).toBeUndefined();
	});

	it("does not create a control database when it has not been initialized", () => {
		const controlDbPath = join(tmpdir(), `pi-architect-missing-${crypto.randomUUID()}.sqlite`);

		expect(readArchitectSnapshot(controlDbPath, 0)).toEqual({ messages: [], sessions: [] });
		expect(existsSync(controlDbPath)).toBe(false);
	});

	it("does not treat channel history as a new architect request", () => {
		const reads = [
			{
				messages: [{ body: "Architect: old request", id: 3, senderAgentId: null, senderSessionId: "main" }],
				sessions: [session],
			},
			{
				messages: [{ body: "Architect: new request", id: 4, senderAgentId: null, senderSessionId: "main" }],
				sessions: [session],
			},
		];
		const observer = new ArchitectObserver("/unused", () => {
			const next = reads.shift();
			if (!next) throw new Error("unexpected read");
			return next;
		});

		expect(observer.observe()).toMatchObject({ reason: "session_state_changed", requests: [] });
		expect(observer.observe()).toMatchObject({ reason: "architect_request", requests: [{ id: 4 }] });
	});
});
