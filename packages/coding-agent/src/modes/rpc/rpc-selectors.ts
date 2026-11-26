/**
 * `/approvals` and `/sandbox` selectors for RPC clients: the TUI's selector
 * components become two `select` dialogs, save scope first, then the value.
 */

import type { AgentSession } from "../../core/agent-session.ts";
import {
	APPROVAL_PRESETS,
	SANDBOX_PROFILES,
	type SandboxProfileName,
	type SandboxProfileScope,
} from "../../core/permissions/presets.ts";

const INHERIT_LABEL = "Inherit global/project";

/** Option labels with the current one marked, and the chosen label's index. */
async function selectMarked(
	session: AgentSession,
	title: string,
	labels: readonly string[],
	current: number,
): Promise<number | undefined> {
	const options = labels.map((label, i) => (i === current ? `${label} (current)` : label));
	const choice = await session.extensionRunner.getUIContext().select(title, options);
	const index = choice === undefined ? -1 : options.indexOf(choice);
	return index < 0 ? undefined : index;
}

function saveAndReport(session: AgentSession, save: () => void, message: string): void {
	const ui = session.extensionRunner.getUIContext();
	try {
		save();
		ui.notify(message, "info");
	} catch (error) {
		ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export async function selectApprovalPreset(session: AgentSession): Promise<void> {
	const ui = session.extensionRunner.getUIContext();
	const scope = await ui.select("Save approval preset to", ["global", "project"]);
	if (scope !== "global" && scope !== "project") return;
	const current = APPROVAL_PRESETS.findIndex((p) => p.name === session.settingsManager.getApprovalPreset());
	const labels = APPROVAL_PRESETS.map((p) => p.label);
	const index = await selectMarked(session, "Approval preset", labels, current);
	const preset = index === undefined ? undefined : APPROVAL_PRESETS[index];
	if (!preset) return;
	saveAndReport(
		session,
		() => session.settingsManager.setApprovalPreset(preset.name, scope),
		`Saved approval preset ${preset.label} to ${scope} settings. Restart pi for this to take effect.`,
	);
}

export async function selectSandboxProfile(session: AgentSession): Promise<void> {
	const ui = session.extensionRunner.getUIContext();
	const scope = (await ui.select("Save sandbox profile to", ["global", "project", "session"])) as
		| SandboxProfileScope
		| undefined;
	if (scope !== "global" && scope !== "project" && scope !== "session") return;
	const settings = session.settingsManager;
	const profiles: (SandboxProfileName | undefined)[] = SANDBOX_PROFILES.map((p) => p.name);
	const labels: string[] = SANDBOX_PROFILES.map((p) => p.label);
	if (scope === "session") {
		profiles.unshift(undefined);
		labels.unshift(INHERIT_LABEL);
	}
	const active = scope === "session" ? settings.getSessionSandboxProfile() : settings.getConfiguredSandboxProfile();
	const index = await selectMarked(session, "Sandbox profile", labels, profiles.indexOf(active));
	if (index === undefined) return;
	const profile = profiles[index];
	saveAndReport(
		session,
		() => session.extensionRunner.setSandboxProfile(profile, scope),
		`Saved sandbox profile ${profile ?? "inherit"} to ${scope} scope.`,
	);
}
