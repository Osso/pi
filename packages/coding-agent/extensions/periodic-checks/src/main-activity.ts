import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";

const maxEvents = 120;
const maxAgents = 40;
const maxSummaryChars = 160;
const summaryArgumentKeys = ["command", "code", "path", "prompt", "body", "query", "reason", "agentId"];

type ActivityEvent = { timestamp: string; line: string };

function collapse(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > maxSummaryChars ? `${flat.slice(0, maxSummaryChars)}…` : flat;
}

function summarizeArguments(args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	const record = args as Record<string, unknown>;
	const key = summaryArgumentKeys.find((name) => typeof record[name] === "string");
	return collapse(key ? String(record[key]) : JSON.stringify(record));
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join(" ");
}

function entryEvents(entry: SessionEntry): ActivityEvent[] {
	if (entry.type !== "message") return [];
	const { message } = entry;
	if (message.role === "user") {
		return [{ timestamp: entry.timestamp, line: `user: ${collapse(messageText(message.content))}` }];
	}
	if (message.role !== "assistant") return [];
	return message.content
		.filter((part) => part.type === "toolCall")
		.map((call) => ({ timestamp: entry.timestamp, line: `tool ${call.name}: ${summarizeArguments(call.arguments)}` }));
}

function recentMainEvents(ctx: ExtensionContext, windowMs: number, now: number): ActivityEvent[] {
	const since = now - windowMs;
	return ctx.sessionManager
		.getBranch()
		.filter((entry) => Date.parse(entry.timestamp) >= since)
		.flatMap(entryEvents);
}

function countToolCalls(events: ActivityEvent[]): string {
	const counts = new Map<string, number>();
	for (const { line } of events) {
		const name = /^tool ([^:]+):/.exec(line)?.[1];
		if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	const sorted = [...counts].sort((a, b) => b[1] - a[1]);
	return sorted.length ? sorted.map(([name, count]) => `${name} ${count}`).join(", ") : "none";
}

function childAgentLines(ctx: ExtensionContext): string[] {
	const agents = [...(ctx.multiAgentStore?.listAgents() ?? [])]
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
		.slice(0, maxAgents);
	if (agents.length === 0) return ["- none"];
	return agents.map(
		(agent) =>
			`- ${agent.id} ${agent.agentType} "${agent.displayName}" ${agent.lifecycle} created ${agent.createdAt} updated ${agent.updatedAt}`,
	);
}

/** Bounded read-only evidence of main's recent work; audit children cannot read main's transcript or agent store. */
export function buildMainActivitySnapshot(ctx: ExtensionContext, windowMs: number, now = Date.now()): string {
	const events = recentMainEvents(ctx, windowMs, now);
	const shown = events.slice(-maxEvents);
	const omitted = events.length - shown.length;
	return [
		`Main activity snapshot for session ${ctx.sessionManager.getSessionId()}, last ${Math.round(windowMs / 60_000)} minutes, captured ${new Date(now).toISOString()}.`,
		"Main's child agents (newest first):",
		...childAgentLines(ctx),
		`Main tool calls by name: ${countToolCalls(events)}`,
		`Main user messages and tool calls (oldest first${omitted > 0 ? `, ${omitted} older omitted` : ""}):`,
		...(shown.length ? shown.map(({ timestamp, line }) => `- ${timestamp} ${line}`) : ["- none"]),
	].join("\n");
}
