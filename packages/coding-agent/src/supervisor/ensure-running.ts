import { ensureRelayRunning, isRelayRunning } from "../core/host-relay-resident.ts";
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
	/** Starts this host's relay; tests replace the real launcher. */
	startRelay?: typeof ensureRelayRunning;
}

/**
 * Returns where to send typed Supervisor requests: the session named by `supervisor.sessionId`.
 * A local Supervisor session must be live; one on another host needs this host's relay running, so a stopped
 * configured relay is started again here (sessions otherwise start it only at their own startup).
 */
export async function ensureSupervisorAvailable(input: EnsureSupervisorAvailableInput): Promise<SupervisorAddress> {
	const settings = SettingsManager.create(process.cwd(), undefined, { projectTrusted: false });
	const { sessionId, host } = settings.getMergedSettings().supervisor ?? {};
	if (!sessionId) throw new Error("no Supervisor session is configured; set supervisor.sessionId");
	if (isRemoteHost(host)) {
		if (!isRelayRunning(input.controlDbPath)) {
			await (input.startRelay ?? ensureRelayRunning)(input.controlDbPath, settings.getGlobalSettings().relay);
		}
		if (!isRelayRunning(input.controlDbPath)) {
			throw new Error(`the relay to the Supervisor on host ${host} is not running`);
		}
		return { sessionId, host };
	}
	const pid = readSessionHealth(input.controlDbPath, sessionId)?.pid;
	if (!pid || !isVerifiedPiRuntimeProcess(pid)) {
		throw new SupervisorNotRunningError({ sessionId });
	}
	return { sessionId };
}
