import { describe, expect, it } from "vitest";
import {
	type ArchitectChannelMessage,
	type ArchitectSessionSnapshot,
	createArchitectObservation,
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

	it("ignores subagent and unrelated channel posts", () => {
		const previous = createArchitectObservation(undefined, [session], []);
		if (!previous) throw new Error("expected initial observation");
		const messages: ArchitectChannelMessage[] = [
			{ body: "Architect: ignore this", id: 5, senderAgentId: "agent_1", senderSessionId: "child" },
			{ body: "normal update", id: 6, senderAgentId: null, senderSessionId: "other-main" },
		];

		expect(createArchitectObservation(previous, [session], messages)).toBeUndefined();
	});
});
