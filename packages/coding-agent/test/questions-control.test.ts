import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleQuestionsControl } from "../src/cli/questions-control.ts";
import { ENV_AGENT_DIR, ENV_STATE_DIR } from "../src/config.ts";
import {
	cancelSupervisorRequest,
	claimNextSupervisorRequest,
	completeSupervisorRequest,
	getControlDbPath,
	postSupervisorRequest,
	recordUserQuestionAnswer,
} from "../src/core/session-control-db.ts";

const QUESTION = "Which test runner should this project use?";
const SUPERVISOR = "supervisor-session";

interface Run {
	code: number;
	out: string;
	err: string;
}

function run(...args: string[]): Run {
	let out = "";
	let err = "";
	process.exitCode = 0;
	handleQuestionsControl(
		args,
		(text) => {
			out += text;
		},
		(text) => {
			err += text;
		},
	);
	const code = Number(process.exitCode ?? 0);
	process.exitCode = 0;
	return { code, out, err };
}

describe("pi control questions", () => {
	let root: string;
	let controlDbPath: string;
	const savedEnv = { agent: process.env[ENV_AGENT_DIR], state: process.env[ENV_STATE_DIR] };

	function writeSettings(supervisor: Record<string, string>): void {
		writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ supervisor }));
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-questions-cli-"));
		mkdirSync(join(root, "agent"));
		process.env[ENV_AGENT_DIR] = join(root, "agent");
		process.env[ENV_STATE_DIR] = join(root, "state");
		controlDbPath = getControlDbPath();
		writeSettings({ sessionId: SUPERVISOR });
	});

	afterEach(() => {
		for (const [key, value] of [
			[ENV_AGENT_DIR, savedEnv.agent],
			[ENV_STATE_DIR, savedEnv.state],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	function escalatedQuestion(): number {
		const id = postSupervisorRequest(controlDbPath, {
			deadlineAt: "9999-12-31T23:59:59.999Z",
			kind: "question",
			payload: { blocking: true, questions: [{ question: QUESTION }] },
			projectId: "pi",
			replyTo: { sessionId: "asker", agentId: null, requestId: "call-1", host: "laptop" },
			senderSessionId: "asker",
		});
		const claimed = claimNextSupervisorRequest(controlDbPath, "claim");
		completeSupervisorRequest(controlDbPath, id, claimed?.claimToken ?? "", {
			kind: "escalate",
			reason: "Tradeoff.",
		});
		return id;
	}

	/** Queued mailbox rows with the relay host they are addressed to. */
	function mail(): Array<{ id: string; body: string; host?: string }> {
		const db = new DatabaseSync(controlDbPath);
		try {
			const rows = db.prepare("SELECT message_id, data FROM multi_agent_mailbox_messages").all() as Array<{
				message_id: string;
				data: string;
			}>;
			return rows.map((row) => {
				const data = JSON.parse(row.data) as { body: string; recipientHost?: string };
				return { id: row.message_id, body: data.body, host: data.recipientHost };
			});
		} finally {
			db.close();
		}
	}

	it("answers an escalated agent question, then sends a revision as a correction", () => {
		escalatedQuestion();
		expect(run("list").out).toContain(`a1 open`);
		expect(run("list").out).toContain(`laptop:asker`);

		expect(run("answer", "a1", "vitest")).toMatchObject({ code: 0, out: "answered a1\n" });
		expect(mail()).toContainEqual(
			expect.objectContaining({ id: "supervisor_response:asker:main:call-1:answer", host: "laptop" }),
		);
		expect(run("list").out).toContain(`${QUESTION} → vitest`);

		expect(run("answer", "a1", "jest")).toMatchObject({ code: 0, out: "revised a1\n" });
		const correction = mail().find((message) => message.id.startsWith("supervisor_correction:"));
		expect(correction).toMatchObject({ host: "laptop" });
		expect(correction?.body).toBe(`User revised answers (request call-1):\n- ${QUESTION} → jest`);
		expect(run("list").out).toContain("answered");
		expect(run("list").out).toContain("by user (revised)");
	});

	it("answers a question that ended without an answer and sends the answer to the asker", () => {
		escalatedQuestion();
		cancelSupervisorRequest(
			controlDbPath,
			{ sessionId: "asker", agentId: null, requestId: "call-1" },
			"Asker stopped.",
		);
		expect(run("list").out).toContain("a1 cancelled");

		expect(run("answer", "a1", "vitest")).toMatchObject({ code: 0, out: "answered a1\n" });

		const late = mail().find((message) => message.id.startsWith("supervisor_correction:"));
		expect(late).toMatchObject({ host: "laptop" });
		expect(late?.body).toBe(
			`User answered after the question ended without an answer (request call-1):\n- ${QUESTION} → vitest`,
		);
		expect(run("list").out).toContain(`${QUESTION} → vitest`);
		expect(run("answer", "a1", "jest")).toMatchObject({ code: 0, out: "revised a1\n" });
	});

	it("asks a session, then a follow-up that carries the earlier answer to the same session", () => {
		expect(run("ask", "worker", "--host", "laptop", "Why", "did", "the", "build", "fail?")).toMatchObject({
			code: 0,
			out: "asked u1\n",
		});
		recordUserQuestionAnswer(controlDbPath, 1, "A missing lockfile entry.");

		expect(run("follow-up", "u1", "Which", "package?")).toMatchObject({ code: 0, out: "asked u2\n" });

		const followUp = mail().find((message) => message.id === "user_question:2");
		expect(followUp).toMatchObject({ host: "laptop" });
		expect(followUp?.body).toContain('to question 1: "Why did the build fail?" → "A missing lockfile entry."');
		expect(followUp?.body).toContain("Which package?");
		const listed = JSON.parse(run("list", "--json").out) as Array<Record<string, unknown>>;
		expect(listed.map((entry) => [entry.ref, entry.parentId, entry.state])).toEqual([
			["u2", 1, "open"],
			["u1", undefined, "answered"],
		]);
	});

	it("rejects answers the store cannot take", () => {
		escalatedQuestion();
		expect(run("answer", "a1", "--json", JSON.stringify({ "Another question?": "x" }))).toMatchObject({
			code: 1,
			err: 'a1 does not ask "Another question?".\n',
		});
		expect(run("answer", "a9", "x")).toMatchObject({ code: 1, err: "No stored agent question a9.\n" });
		expect(run("follow-up", "a1", "x")).toMatchObject({ code: 1 });
		expect(mail()).toEqual([]);
	});

	it("refuses to run away from the store host", () => {
		writeSettings({ sessionId: SUPERVISOR, host: `not-${hostname()}` });
		expect(run("list")).toMatchObject({
			code: 1,
			err: `The question store is on not-${hostname()}; run pi questions there.\n`,
		});
	});
});
