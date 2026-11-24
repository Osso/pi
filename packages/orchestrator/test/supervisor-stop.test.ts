import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const radius = vi.hoisted(() => ({
	registerPi: vi.fn(),
	disconnectPi: vi.fn(),
	setCoordinator: vi.fn(),
}));
const child = vi.hoisted(() => ({
	dispose: vi.fn(async () => {}),
	uiRequestHandler: undefined as ((request: unknown) => void) | undefined,
}));

vi.mock("../src/radius.ts", () => ({ radiusPresence: radius }));
vi.mock("../src/rpc-process.ts", () => ({
	createRpcProcessInstance: () => ({
		send: async () => ({
			type: "response",
			command: "get_state",
			success: true,
			data: { sessionId: "session-1", sessionFile: "/tmp/session-1.jsonl" },
		}),
		onEvent: () => () => {},
		onExit: () => () => {},
		setUiRequestHandler: (handler: ((request: unknown) => void) | undefined) => {
			child.uiRequestHandler = handler;
		},
		handleUiResponse: () => {},
		dispose: child.dispose,
	}),
}));

import { OrchestratorSupervisor } from "../src/supervisor.ts";

describe("OrchestratorSupervisor", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "orchestrator-supervisor-"));
		vi.stubEnv("PI_ORCHESTRATOR_DIR", directory);
		radius.registerPi.mockImplementation(async (instance) => ({ ...instance, radiusPiId: "radius-1" }));
		radius.disconnectPi.mockRejectedValue(new Error("Radius disconnect failed: 503"));
		child.dispose.mockClear();
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	it("still stops the child process when the Radius disconnect fails", async () => {
		const supervisor = new OrchestratorSupervisor();
		const instance = await supervisor.spawnInstance({ cwd: "/tmp" });

		await expect(supervisor.stopInstance(instance.id)).rejects.toThrow("Radius disconnect failed: 503");

		expect(supervisor.listInstances()).toEqual([]);
		expect(child.dispose).toHaveBeenCalledOnce();
	});

	it("routes dialogs to a remaining stream after a later stream closes", async () => {
		radius.disconnectPi.mockResolvedValue(undefined);
		const supervisor = new OrchestratorSupervisor();
		const instance = await supervisor.spawnInstance({ cwd: "/tmp" });
		const firstDialogs: unknown[] = [];
		const secondDialogs: unknown[] = [];
		supervisor.openRpcStream(
			instance.id,
			() => {},
			(request) => firstDialogs.push(request),
		);
		const second = supervisor.openRpcStream(
			instance.id,
			() => {},
			(request) => secondDialogs.push(request),
		);

		second?.close();
		const dialog = { type: "extension_ui_request", id: "dialog", method: "confirm", title: "Continue?", message: "" };
		child.uiRequestHandler?.(dialog);

		expect(firstDialogs).toEqual([dialog]);
		expect(secondDialogs).toEqual([]);
	});
});
