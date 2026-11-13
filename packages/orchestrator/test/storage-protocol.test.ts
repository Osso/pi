import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getInstancesPath, getMachinePath } from "../src/config.ts";
import { parseRequestLine, parseResponseLine, parseRpcClientMessage } from "../src/ipc/protocol.ts";
import { loadInstances, loadMachine, saveInstances, saveMachine } from "../src/storage.ts";

describe("orchestrator storage and protocol boundaries", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function createStateDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-orch-storage-"));
		tempDirs.push(dir);
		vi.stubEnv("PI_ORCHESTRATOR_DIR", dir);
		return dir;
	}

	it("loads valid machine and instance records", () => {
		createStateDir();
		const machine = { id: "m1", createdAt: "2026-11-12T00:00:00Z", label: "box" };
		const instances = [
			{
				id: "i1",
				status: "online" as const,
				cwd: "/repo",
				createdAt: "2026-11-12T00:00:00Z",
			},
		];
		saveMachine(machine);
		saveInstances(instances);

		expect(loadMachine()).toEqual(machine);
		expect(loadInstances()).toEqual(instances);
	});

	it("throws contextual errors on corrupt machine.json or instances.json", () => {
		createStateDir();
		writeFileSync(getMachinePath(), "{not-json");
		expect(() => loadMachine()).toThrow(/Failed to parse machine JSON/);

		writeFileSync(getMachinePath(), JSON.stringify({ id: "m1" }));
		expect(() => loadMachine()).toThrow(/Invalid machine record/);

		writeFileSync(getInstancesPath(), "{not-json");
		expect(() => loadInstances()).toThrow(/Failed to parse instances JSON/);

		writeFileSync(getInstancesPath(), JSON.stringify([{ id: "i1", status: "bogus", cwd: "/repo", createdAt: "t" }]));
		expect(() => loadInstances()).toThrow(/Invalid instances list/);
	});

	it("rejects malformed or non-object IPC request, response, and RPC messages", () => {
		expect(() => parseRequestLine("{bad")).toThrow(/Invalid orchestrator request JSON/);
		expect(() => parseRequestLine("[]")).toThrow(/expected a JSON object/);
		expect(() => parseRequestLine("{}")).toThrow(/missing string type/);
		expect(parseRequestLine('{"type":"list"}')).toEqual({ type: "list" });

		expect(() => parseResponseLine("null")).toThrow(/expected a JSON object/);
		expect(() => parseResponseLine('{"type":"list_result"}')).toThrow(/missing type or ok/);
		expect(parseResponseLine('{"type":"list_result","ok":true,"instances":[]}')).toEqual({
			type: "list_result",
			ok: true,
			instances: [],
		});

		expect(() => parseRpcClientMessage("123")).toThrow(/expected a JSON object/);
		expect(() => parseRpcClientMessage('{"type":""}')).toThrow(/missing string type/);
		expect(parseRpcClientMessage('{"type":"get_state"}')).toEqual({ type: "get_state" });
	});
});
