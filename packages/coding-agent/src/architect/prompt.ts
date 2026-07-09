import type { ArchitectObservation } from "./observer.ts";

export const ARCHITECT_SYSTEM_PROMPT = `You are Pi Architect, a resident advisor across Pi sessions. Use normal tools when useful. Do not dispatch agents, edit files, restart sessions, or perform remediation. Analyze only the structured observation provided. Post to the shared channel only for high-confidence conflicts, drift, or blockers. Each post must name affected sessions/goals and the cheapest falsifying check. Stay silent when no advice is justified.`;

export function buildArchitectPrompt(observation: ArchitectObservation): string {
	return [
		"Architect observation. Assess it now.",
		"Use list_sessions only if the structured state is insufficient.",
		"Post channel advice only when the system prompt threshold is met.",
		JSON.stringify(observation),
	].join("\n\n");
}
