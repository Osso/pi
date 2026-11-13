import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import type { InstanceStatus } from "../types.ts";

export interface SpawnRequest {
	type: "spawn";
	cwd: string;
	label?: string;
	provider?: string;
	model?: string;
}

export interface ListRequest {
	type: "list";
}

export interface StopRequest {
	type: "stop";
	instanceId: string;
}

export interface StatusRequest {
	type: "status";
	instanceId: string;
}

export interface RpcRequest {
	type: "rpc";
	instanceId: string;
	command: RpcCommand;
}

export interface RpcStreamRequest {
	type: "rpc_stream";
	instanceId: string;
}

export interface RequestMap {
	spawn: SpawnRequest;
	list: ListRequest;
	stop: StopRequest;
	status: StatusRequest;
	rpc: RpcRequest;
	rpc_stream: RpcStreamRequest;
}

export type OrchestratorRequest = RequestMap[keyof RequestMap];

export interface InstanceSummary {
	id: string;
	status: InstanceStatus;
	cwd: string;
	label?: string;
	sessionId?: string;
	sessionFile?: string;
	radiusPiId?: string;
}

export interface ResponseBase {
	ok: boolean;
	error?: string;
}

export interface SpawnResponse extends ResponseBase {
	type: "spawn_result";
	instance?: InstanceSummary;
}

export interface ListResponse extends ResponseBase {
	type: "list_result";
	instances?: InstanceSummary[];
}

export interface StopResponse extends ResponseBase {
	type: "stop_result";
	instanceId?: string;
}

export interface StatusResponse extends ResponseBase {
	type: "status_result";
	instance?: InstanceSummary;
}

export interface RpcBridgeResponse extends ResponseBase {
	type: "rpc_result";
	response: RpcResponse;
}

export interface RpcReadyResponse extends ResponseBase {
	type: "rpc_ready";
	instance?: InstanceSummary;
}

export interface ErrorResponse extends ResponseBase {
	type: "error";
	ok: false;
	error: string;
}

export interface ResponseMap {
	spawn: SpawnResponse;
	list: ListResponse;
	stop: StopResponse;
	status: StatusResponse;
	rpc: RpcBridgeResponse;
	rpc_stream: RpcReadyResponse;
}

export type OrchestratorResponse = ResponseMap[keyof ResponseMap] | ErrorResponse;
export type RpcClientMessage = RpcCommand | RpcExtensionUIResponse;
export type RpcServerMessage =
	| RpcReadyResponse
	| RpcResponse
	| AgentSessionEvent
	| RpcExtensionUIRequest
	| ErrorResponse;
export type ProtocolMessage = OrchestratorRequest | OrchestratorResponse | RpcClientMessage | RpcServerMessage;

export type ResponseFor<T extends OrchestratorRequest> = T extends { type: infer K }
	? K extends keyof ResponseMap
		? ResponseMap[K] | ErrorResponse
		: ErrorResponse
	: ErrorResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(line: string, context: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw new Error(`Invalid ${context} JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) {
		throw new Error(`Invalid ${context}: expected a JSON object`);
	}
	return parsed;
}

export function encodeMessage(message: ProtocolMessage): string {
	return `${JSON.stringify(message)}\n`;
}

export function parseRequestLine(line: string): OrchestratorRequest {
	const value = parseJsonObject(line, "orchestrator request");
	if (typeof value.type !== "string" || value.type.length === 0) {
		throw new Error("Invalid orchestrator request: missing string type");
	}
	return value as unknown as OrchestratorRequest;
}

export function parseResponseLine(line: string): OrchestratorResponse {
	const value = parseJsonObject(line, "orchestrator response");
	if (typeof value.type !== "string" || value.type.length === 0 || typeof value.ok !== "boolean") {
		throw new Error("Invalid orchestrator response: missing type or ok");
	}
	return value as unknown as OrchestratorResponse;
}

export function parseRpcClientMessage(line: string): RpcClientMessage {
	const value = parseJsonObject(line, "RPC command");
	if (typeof value.type !== "string" || value.type.length === 0) {
		throw new Error("Invalid RPC command: missing string type");
	}
	return value as unknown as RpcClientMessage;
}
