import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { getInstancesPath, getMachinePath, getOrchestratorDir } from "./config.ts";
import type { InstanceRecord, InstanceStatus, MachineRecord } from "./types.ts";

const INSTANCE_STATUSES: ReadonlySet<InstanceStatus> = new Set(["starting", "online", "stopping", "stopped", "error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isMachineRecord(value: unknown): value is MachineRecord {
	if (!isRecord(value)) {
		return false;
	}
	return (
		typeof value.id === "string" &&
		typeof value.createdAt === "string" &&
		isOptionalString(value.lastSeenAt) &&
		isOptionalString(value.label)
	);
}

function isInstanceRecord(value: unknown): value is InstanceRecord {
	if (!isRecord(value)) {
		return false;
	}
	return (
		typeof value.id === "string" &&
		typeof value.status === "string" &&
		INSTANCE_STATUSES.has(value.status as InstanceStatus) &&
		typeof value.cwd === "string" &&
		typeof value.createdAt === "string" &&
		isOptionalString(value.lastSeenAt) &&
		isOptionalString(value.label) &&
		isOptionalString(value.sessionId) &&
		isOptionalString(value.sessionFile) &&
		isOptionalString(value.radiusPiId)
	);
}

function parseJsonFile(path: string, label: string): unknown {
	const data = readFileSync(path, "utf-8");
	try {
		return JSON.parse(data) as unknown;
	} catch (error) {
		throw new Error(
			`Failed to parse ${label} JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function ensureOrchestratorDir(): void {
	const orchestratorDir = getOrchestratorDir();
	if (!existsSync(orchestratorDir)) {
		mkdirSync(orchestratorDir, { recursive: true });
	}
}

export function loadMachine(): MachineRecord | undefined {
	const machinePath = getMachinePath();
	if (!existsSync(machinePath)) {
		return undefined;
	}

	const parsed = parseJsonFile(machinePath, "machine");
	if (!isMachineRecord(parsed)) {
		throw new Error(`Invalid machine record in ${machinePath}`);
	}
	return parsed;
}

export function saveMachine(machine: MachineRecord): void {
	ensureOrchestratorDir();
	writeFileSync(getMachinePath(), JSON.stringify(machine, null, 2));
}

export function deleteMachine(): void {
	const machinePath = getMachinePath();
	if (!existsSync(machinePath)) {
		return;
	}
	rmSync(machinePath);
}

export function loadInstances(): InstanceRecord[] {
	const instancesPath = getInstancesPath();
	if (!existsSync(instancesPath)) {
		return [];
	}

	const parsed = parseJsonFile(instancesPath, "instances");
	if (!Array.isArray(parsed) || !parsed.every(isInstanceRecord)) {
		throw new Error(`Invalid instances list in ${instancesPath}`);
	}
	return parsed;
}

export function saveInstances(instances: InstanceRecord[]): void {
	ensureOrchestratorDir();
	writeFileSync(getInstancesPath(), JSON.stringify(instances, null, 2));
}

export function getInstance(instanceId: string): InstanceRecord | undefined {
	return loadInstances().find((instance) => instance.id === instanceId);
}

export function upsertInstance(instance: InstanceRecord): void {
	const instances = loadInstances();
	const index = instances.findIndex((existing) => existing.id === instance.id);
	if (index === -1) {
		instances.push(instance);
		saveInstances(instances);
		return;
	}

	instances[index] = instance;
	saveInstances(instances);
}

export function removeInstance(instanceId: string): void {
	const instances = loadInstances().filter((instance) => instance.id !== instanceId);
	saveInstances(instances);
}
