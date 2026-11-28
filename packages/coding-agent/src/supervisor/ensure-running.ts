import { isVerifiedPiRuntimeProcess } from "../core/runtime-process.ts";
import { readSessionHealth } from "../core/session-control-db/session-health.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { isRemoteHost, type SupervisorAddress } from "./mail.ts";

/** The local Supervisor session has no live process; while it restarts, its queued requests still get answers. */
export class SupervisorNotRunningError extends Error {
	readonly address: SupervisorAddress;

	constructor(address: SupervisorAddress) {
		super(`the Supervisor session ${address.sessionId} is not running`);
		this.address = address;
	}
}

export interface EnsureSupervisorAvailableInput {
	controlDbPath: string;
}

/**
 * Returns where to send typed Supervisor requests: the session named by `supervisor.sessionId`.
 * A local Supervisor session must be live; one on another host needs a pi server hub (`server.hub`), whose
 * link carries the request.
 */
export async function ensureSupervisorAvailable(input: EnsureSupervisorAvailableInput): Promise<SupervisorAddress> {
	const settings = SettingsManager.create(process.cwd(), undefined, { projectTrusted: false });
	const { sessionId, host } = settings.getMergedSettings().supervisor ?? {};
	if (!sessionId) throw new Error("no Supervisor session is configured; set supervisor.sessionId");
	if (isRemoteHost(host)) {
		// Mail for another host waits in the control DB until this host's pi server sends it over its hub link.
		if (!settings.getMergedSettings().server?.hub) {
			throw new Error(`the Supervisor is on host ${host}, but this host has no pi server hub; set server.hub`);
		}
		return { sessionId, host };
	}
	const pid = readSessionHealth(input.controlDbPath, sessionId)?.pid;
	if (!pid || !isVerifiedPiRuntimeProcess(pid)) {
		throw new SupervisorNotRunningError({ sessionId });
	}
	return { sessionId };
}
