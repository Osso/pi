import { randomUUID } from "node:crypto";
import {
	claimNextSupervisorRequest,
	completeSupervisorRequest,
	readSupervisorRequest,
	type SupervisorRequest,
	type SupervisorResponse,
} from "../../../src/core/session-control-db.ts";
import { startHeadlessSupervisorProbe } from "./headless-supervisor-probe.ts";

const controlDbPath = process.argv[2];
if (!controlDbPath || !process.send) throw new Error("Controlled Supervisor requires isolated DB and IPC");
const residentReady = startHeadlessSupervisorProbe(controlDbPath);

interface Command {
	id: number;
	kind: "claim" | "answer" | "ping" | "close";
	request?: SupervisorRequest;
	response?: SupervisorResponse;
}

async function claimRequest(): Promise<SupervisorRequest> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const request = claimNextSupervisorRequest(controlDbPath, randomUUID());
		if (request) return request;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Controlled Supervisor timed out claiming request");
}

async function execute(command: Command): Promise<unknown> {
	const resident = await residentReady;
	if (command.kind === "claim") return claimRequest();
	if (command.kind === "ping") return { pid: process.pid, ready: true };
	if (command.kind === "close") {
		await resident.close();
		return { closed: true };
	}
	const { request, response } = command;
	if (!request?.claimToken || !response) throw new Error("Claim and response required");
	completeSupervisorRequest(controlDbPath, request.id, request.claimToken, response);
	return readSupervisorRequest(controlDbPath, request.id);
}

process.on("message", (command: Command) => {
	void execute(command).then(
		(value) => {
			process.send?.({ id: command.id, value }, () => {
				if (command.kind === "close") process.disconnect();
			});
		},
		(error: unknown) => {
			process.send?.({ id: command.id, error: error instanceof Error ? error.message : String(error) });
		},
	);
});
