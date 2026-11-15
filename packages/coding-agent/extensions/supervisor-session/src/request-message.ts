import { Box, Text } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../../src/core/extensions/types.ts";

const REQUEST_MARKER = "\nRequest:\n";

/** Payload fields left out of the display; the model still receives them. */
const HIDDEN_PAYLOAD_FIELDS = new Set(["userMessages", "objective"]);

const KIND_LABELS: Record<string, string> = {
	approval_review: "Approval review",
	goal_set_review: "Goal set review",
	goal_idle_review: "Goal idle review",
	goal_completion_review: "Goal completion review",
	supervisor_advisory: "Advisory question",
	question: "Question",
};

function humanizeKey(key: string): string {
	const words = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function indentLines(text: string, indent: string): string {
	return text
		.split("\n")
		.map((line) => `${indent}${line}`)
		.join("\n");
}

function formatScalar(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "none";
	return String(value);
}

/** Renders a JSON value as indented `Label: value` lines and `-` bullets. */
function formatValue(value: unknown, indent: string): string[] {
	if (Array.isArray(value)) {
		if (value.length === 0) return [`${indent}- none`];
		return value.flatMap((item) => {
			if (!isRecord(item) && !Array.isArray(item)) {
				const [first = "", ...rest] = formatScalar(item).split("\n");
				return [`${indent}- ${first}`, ...rest.map((line) => `${indent}  ${line}`)];
			}
			const [first = "", ...rest] = formatValue(item, `${indent}  `);
			return [`${indent}- ${first.trimStart()}`, ...rest];
		});
	}
	if (isRecord(value)) {
		return Object.entries(value).flatMap(([key, entry]) => {
			const label = `${indent}${humanizeKey(key)}:`;
			if (isRecord(entry) || Array.isArray(entry)) return [label, ...formatValue(entry, `${indent}  `)];
			const text = formatScalar(entry);
			return text.includes("\n") ? [label, indentLines(text, `${indent}  `)] : [`${label} ${text}`];
		});
	}
	return [`${indent}${formatScalar(value)}`];
}

export interface SupervisorRequestDisplay {
	instructions: string;
	title: string;
	body: string;
}

/** Splits a Supervisor request prompt into its instructions and a readable request summary. */
export function formatSupervisorRequestPrompt(prompt: string): SupervisorRequestDisplay {
	const markerIndex = prompt.indexOf(REQUEST_MARKER);
	if (markerIndex === -1) return { instructions: prompt, title: "Supervisor request", body: "" };
	const instructions = prompt.slice(0, markerIndex);
	let request: unknown;
	try {
		request = JSON.parse(prompt.slice(markerIndex + REQUEST_MARKER.length));
	} catch {
		return { instructions, title: "Supervisor request", body: prompt.slice(markerIndex + REQUEST_MARKER.length) };
	}
	if (!isRecord(request))
		return { instructions, title: "Supervisor request", body: formatValue(request, "").join("\n") };
	const kind = typeof request.kind === "string" ? request.kind : "";
	const payload = isRecord(request.payload) ? request.payload : {};
	const visiblePayload = Object.fromEntries(
		Object.entries(payload).filter(([key]) => !HIDDEN_PAYLOAD_FIELDS.has(key)),
	);
	const header = {
		project: request.projectId,
		fromSession: request.senderSessionId,
		deadline: request.deadlineAt,
	};
	return {
		instructions,
		title: KIND_LABELS[kind] ?? (kind ? humanizeKey(kind) : "Supervisor request"),
		body: [...formatValue(header, ""), ...formatValue(visiblePayload, "")].join("\n"),
	};
}

export const renderSupervisorRequestMessage: MessageRenderer = (message, _options, theme) => {
	const content = typeof message.content === "string" ? message.content : "";
	const display = formatSupervisorRequestPrompt(content);
	const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(`[Supervisor request] ${display.title}`)), 0, 0));
	if (display.body) box.addChild(new Text(theme.fg("customMessageText", display.body), 0, 0));
	box.addChild(new Text(theme.fg("dim", display.instructions), 0, 0));
	return box;
};
