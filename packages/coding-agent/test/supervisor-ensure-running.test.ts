import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import { type ResidentConsoleIdentity, ResidentConsoleServer } from "../src/core/resident-console-transport.ts";
import {
	ensureSupervisorRunning,
	getSupervisorStartLockPath,
	resolveSupervisorLaunchInvocation,
} from "../src/supervisor/ensure-running.ts";

const tempDirs: string[] = [];
const resources: Array<{ close(): Promise<void> }> = [];

function controlDbPath(): string {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-supervisor-ensure-"));
	tempDirs.push(tempDir);
	return join(tempDir, "control.sqlite");
}

function identity(overrides: Partial<ResidentConsoleIdentity> = {}): ResidentConsoleIdentity {
	return {
		version: VERSION,
		pid: 1234,
		executable: "/usr/local/bin/pi",
		entrypoint: "/usr/local/lib/node_modules/pi/dist/cli.js",
		instanceId: "supervisor-instance",
		managedBy: "pi",
		...overrides,
	};
}

afterEach(async () => {
	await Promise.all(resources.splice(0).map((resource) => resource.close()));
	for (const tempDir of tempDirs.splice(0)) rmSync(tempDir, { force: true, recursive: true });
});

describe("ensureSupervisorRunning", () => {
	it("probes the resident console by default", async () => {
		const path = controlDbPath();
		const current = identity({ managedBy: "external" });
		const server = new ResidentConsoleServer({
			socketPath: `${path}.supervisor-console.sock`,
			service: "supervisor",
			getSnapshot: () => ({
				service: "supervisor",
				sessionId: "supervisor",
				cwd: "/resident",
				generation: current.pid,
				identity: current,
				branch: [],
			}),
			enqueuePrompt: () => {},
			subscribe: () => () => {},
		});
		resources.push(server);
		await server.start();

		await expect(ensureSupervisorRunning({ controlDbPath: path })).resolves.toEqual(current);
	});

	it("reuses a compatible resident without starting another process", async () => {
		const current = identity();
		const launch = vi.fn(async () => {});

		await expect(
			ensureSupervisorRunning({ controlDbPath: controlDbPath() }, { launch, probe: async () => current }),
		).resolves.toEqual(current);
		expect(launch).not.toHaveBeenCalled();
	});

	it("starts a missing resident and waits for compatible readiness", async () => {
		let current: ResidentConsoleIdentity | undefined;
		const launch = vi.fn(async () => {
			current = identity();
		});

		await expect(
			ensureSupervisorRunning(
				{ controlDbPath: controlDbPath(), pollIntervalMs: 1, startupTimeoutMs: 100 },
				{ launch, probe: async () => current },
			),
		).resolves.toEqual(identity());
		expect(launch).toHaveBeenCalledOnce();
	});

	it("serializes concurrent starters so only one resident is launched", async () => {
		const path = controlDbPath();
		let current: ResidentConsoleIdentity | undefined;
		const launch = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			current = identity();
		});
		const dependencies = { launch, probe: async () => current };

		const [first, second] = await Promise.all([
			ensureSupervisorRunning({ controlDbPath: path, pollIntervalMs: 1, startupTimeoutMs: 500 }, dependencies),
			ensureSupervisorRunning({ controlDbPath: path, pollIntervalMs: 1, startupTimeoutMs: 500 }, dependencies),
		]);

		expect(first.instanceId).toBe("supervisor-instance");
		expect(second.instanceId).toBe("supervisor-instance");
		expect(launch).toHaveBeenCalledOnce();
	});

	it("recovers an abandoned stale startup lock", async () => {
		const path = controlDbPath();
		const lockPath = getSupervisorStartLockPath(path);
		mkdirSync(lockPath);
		const staleTime = new Date(Date.now() - 10_000);
		utimesSync(lockPath, staleTime, staleTime);
		let current: ResidentConsoleIdentity | undefined;

		await expect(
			ensureSupervisorRunning(
				{ controlDbPath: path, pollIntervalMs: 1, startupTimeoutMs: 100 },
				{
					launch: async () => {
						current = identity();
					},
					probe: async () => current,
				},
			),
		).resolves.toEqual(identity());
		expect(existsSync(lockPath)).toBe(false);
	});

	it("replaces an incompatible Pi-managed resident", async () => {
		const oldIdentity = identity({ version: "0.79.0", instanceId: "old-instance" });
		let current: ResidentConsoleIdentity | undefined = oldIdentity;
		const terminate = vi.fn(async (resident: ResidentConsoleIdentity) => {
			expect(resident).toEqual(oldIdentity);
			current = undefined;
		});
		const launch = vi.fn(async () => {
			current = identity();
		});

		await expect(
			ensureSupervisorRunning(
				{ controlDbPath: controlDbPath(), pollIntervalMs: 1, startupTimeoutMs: 100 },
				{ launch, probe: async () => current, terminate },
			),
		).resolves.toEqual(identity());
		expect(terminate).toHaveBeenCalledOnce();
		expect(launch).toHaveBeenCalledOnce();
	});

	it("does not replace an externally managed incompatible resident", async () => {
		const launch = vi.fn(async () => {});
		const terminate = vi.fn(async () => {});

		await expect(
			ensureSupervisorRunning(
				{ controlDbPath: controlDbPath() },
				{
					launch,
					probe: async () => identity({ managedBy: "external", version: "0.79.0" }),
					terminate,
				},
			),
		).rejects.toThrow("externally managed Supervisor version 0.79.0 does not match Pi version");
		expect(terminate).not.toHaveBeenCalled();
		expect(launch).not.toHaveBeenCalled();
	});

	it("reports a bounded readiness failure", async () => {
		await expect(
			ensureSupervisorRunning(
				{ controlDbPath: controlDbPath(), pollIntervalMs: 1, startupTimeoutMs: 20 },
				{ launch: async () => {}, probe: async () => undefined },
			),
		).rejects.toThrow("Supervisor did not become ready within 20ms");
	});
});

describe("resolveSupervisorLaunchInvocation", () => {
	it("relaunches a compiled Pi binary directly", () => {
		expect(
			resolveSupervisorLaunchInvocation({
				argv: ["/opt/pi", "current-argument"],
				execArgv: [],
				execPath: "/opt/pi",
				homeDir: "/home/alessio",
				isCompiledBinary: true,
				env: { PATH: "/usr/bin" },
			}),
		).toEqual({
			command: "/opt/pi",
			args: ["supervisor"],
			cwd: "/home/alessio",
			env: { PATH: "/usr/bin", PI_SUPERVISOR_AUTOSTARTED: "1" },
		});
	});

	it("preserves Node runtime flags and the active CLI entrypoint", () => {
		expect(
			resolveSupervisorLaunchInvocation({
				argv: ["/usr/bin/node", "/package/dist/cli.js", "current-argument"],
				execArgv: ["--enable-source-maps"],
				execPath: "/usr/bin/node",
				homeDir: "/Users/alessio",
				isCompiledBinary: false,
				env: { PATH: "/usr/bin" },
			}),
		).toEqual({
			command: "/usr/bin/node",
			args: ["--enable-source-maps", "/package/dist/cli.js", "supervisor"],
			cwd: "/Users/alessio",
			env: { PATH: "/usr/bin", PI_SUPERVISOR_AUTOSTARTED: "1" },
		});
	});
});
