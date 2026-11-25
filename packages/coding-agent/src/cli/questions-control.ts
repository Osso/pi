import { getAgentDir } from "../config.ts";
import { getControlDbPath } from "../core/session-control-db.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import {
	type AgentQuestionEntry,
	answerAgentQuestion,
	askAgent,
	listQuestionEntries,
	openQuestionCenter,
	type QuestionCenter,
	type QuestionEntry,
	readQuestionEntry,
} from "../questions/question-center.ts";

type Write = (text: string) => void;

const USAGE = `Usage:
  pi control questions list [--json]
  pi control questions answer <a-ref> <answer>            answer or revise a one-question entry
  pi control questions answer <a-ref> --json <answers>     answers object keyed by exact question text
  pi control questions ask <session-id> [--host <host>] <question>
  pi control questions follow-up <u-ref> <question>
`;

export function openQuestionCenterForCli(): QuestionCenter {
	const settingsManager = SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: false });
	return openQuestionCenter(settingsManager, getControlDbPath());
}

function describeEntry(entry: QuestionEntry): string {
	const where = entry.session.host ? `${entry.session.host}:${entry.session.sessionId}` : entry.session.sessionId;
	const head = `${entry.ref} ${entry.state} ${entry.createdAt} ${where}`;
	if (entry.direction === "user") {
		const parent = entry.parentId === undefined ? "" : ` (follow-up to u${entry.parentId})`;
		const answer = entry.answer === undefined ? [] : [`  answer source: Agent`, `  → ${entry.answer}`];
		return [`${head}${parent}`, `  you asked: ${entry.question}`, ...answer].join("\n");
	}
	const source =
		entry.state === "answered" ? ` by ${entry.answeredBy ?? "unknown"}${entry.revisedAt ? " (revised)" : ""}` : "";
	const lines = entry.questions.map((question) => {
		const answer = entry.answers?.[question.question];
		return `  ${question.question}${answer === undefined ? "" : ` → ${answer}`}`;
	});
	return [`${head}${source}`, ...lines].join("\n");
}

function parseAnswers(entry: AgentQuestionEntry, args: string[]): Record<string, string> {
	if (args[0] === "--json") {
		const parsed: unknown = JSON.parse(args[1] ?? "");
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("--json expects an object of answers keyed by question text.");
		}
		return Object.fromEntries(Object.entries(parsed).map(([question, answer]) => [question, String(answer)]));
	}
	const [only, ...rest] = entry.questions;
	if (!only || rest.length > 0) throw new Error(`${entry.ref} asks several questions; use --json.`);
	return { [only.question]: args.join(" ") };
}

function runQuestionsCommand(center: QuestionCenter, args: string[], stdout: Write): void {
	const [action, ...rest] = args;
	if (action === "list") {
		const entries = listQuestionEntries(center);
		if (rest.includes("--json")) stdout(`${JSON.stringify(entries, null, 2)}\n`);
		else stdout(entries.length === 0 ? "No stored questions.\n" : `${entries.map(describeEntry).join("\n\n")}\n`);
		return;
	}
	if (action === "answer") {
		const entry = readQuestionEntry(center, rest[0] ?? "");
		if (entry.direction !== "agent") throw new Error(`${entry.ref} is your question; agents answer it.`);
		const outcome = answerAgentQuestion(center, entry, parseAnswers(entry, rest.slice(1)));
		stdout(`${outcome} ${entry.ref}\n`);
		return;
	}
	if (action === "ask") {
		const [sessionId, ...words] = rest;
		const hostIndex = words.indexOf("--host");
		const host = hostIndex === -1 ? undefined : words[hostIndex + 1];
		if (hostIndex !== -1) words.splice(hostIndex, 2);
		if (!sessionId) throw new Error("Missing session ID.");
		stdout(`asked ${askAgent(center, { sessionId, host }, words.join(" ")).ref}\n`);
		return;
	}
	if (action === "follow-up") {
		const entry = readQuestionEntry(center, rest[0] ?? "");
		if (entry.direction !== "user") throw new Error(`${entry.ref} is an agent question; answer it instead.`);
		stdout(`asked ${askAgent(center, { followUpOf: entry }, rest.slice(1).join(" ")).ref}\n`);
		return;
	}
	throw new Error(USAGE);
}

function writeFully(stream: NodeJS.WriteStream, text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		stream.write(text, (error) => (error ? reject(error) : resolve()));
	});
}

/**
 * Runs `pi control questions ...` and waits until its output is flushed: the caller exits the process
 * next, and the compiled binary drops unflushed pipe output (a long `list --json` was cut at 64 KiB).
 */
export async function runQuestionsControl(args: string[]): Promise<void> {
	let out = "";
	let err = "";
	handleQuestionsControl(
		args,
		(text) => {
			out += text;
		},
		(text) => {
			err += text;
		},
	);
	await writeFully(process.stdout, out);
	await writeFully(process.stderr, err);
}

/** `pi control questions ...`: non-interactive access to the question store for scripts and services. */
export function handleQuestionsControl(args: string[], stdout: Write, stderr: Write): void {
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		(args.length === 0 ? stderr : stdout)(USAGE);
		process.exitCode = args.length === 0 ? 1 : 0;
		return;
	}
	try {
		runQuestionsCommand(openQuestionCenterForCli(), args, stdout);
	} catch (error) {
		stderr(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
