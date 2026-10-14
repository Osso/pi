import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type * as RuntimeProcess from "../src/core/runtime-process.ts";
import type { DarwinProcessInfo } from "../src/core/runtime-process-darwin.ts";

const native = vi.hoisted(() => ({
	require: vi.fn<(path: string) => unknown>(),
	readProcessInfo: vi.fn<(pid: number) => unknown>(),
}));

vi.mock("node:module", () => ({
	createRequire: () => native.require,
}));

const hostProcess = process;
const packageDir = "/loader-package-root";
const processInfo: DarwinProcessInfo = { pid: 4200, startTimeTicks: 123_456, state: "R", processGroupId: 5300 };

beforeEach(() => {
	vi.resetModules();
	native.require.mockReset();
	native.readProcessInfo.mockReset();
	native.require.mockReturnValue({ readProcessInfo: native.readProcessInfo });
	native.readProcessInfo.mockImplementation((pid) => ({ ...processInfo, pid }));
	vi.stubGlobal("process", { ...hostProcess, platform: "darwin", arch: "arm64" });
	vi.stubEnv("PI_PACKAGE_DIR", packageDir);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.resetModules();
	native.require.mockReset();
	native.readProcessInfo.mockReset();
});

describe("Darwin process binding lazy loader", () => {
	test.skipIf(hostProcess.platform !== "linux")(
		"imports and reads Linux identity without loading a native binding",
		async () => {
			vi.stubGlobal("process", { ...hostProcess, platform: "linux" });
			native.require.mockImplementation(() => {
				throw new Error("Linux must not load the Darwin binding");
			});
			const runtime = await vi.importActual<typeof RuntimeProcess>("../src/core/runtime-process.ts");

			expect(native.require).not.toHaveBeenCalled();
			const identity = runtime.readProcessIdentity(hostProcess.pid);
			expect(identity.pid).toBe(hostProcess.pid);
			expect(Number.isSafeInteger(identity.startTimeTicks)).toBe(true);
			expect(identity.startTimeTicks).toBeGreaterThan(0);
			expect(runtime.isProcessIdentityAlive(identity)).toBe(true);
			expect(native.require).not.toHaveBeenCalled();
		},
	);

	test.each(["arm64", "x64"])("loads the package's %s binding on first read and caches it", async (arch) => {
		vi.stubGlobal("process", { ...hostProcess, platform: "darwin", arch });
		const runtime = await vi.importActual<typeof RuntimeProcess>("../src/core/runtime-process.ts");

		expect(native.require).not.toHaveBeenCalled();
		expect(runtime.readProcessIdentity(4200)).toEqual({ pid: 4200, startTimeTicks: processInfo.startTimeTicks });
		expect(native.require).toHaveBeenCalledExactlyOnceWith(
			join(packageDir, "native", "darwin", "prebuilds", `darwin-${arch}`, "process-info.node"),
		);
		native.require.mockImplementation(() => {
			throw new Error("A cached binding must not be loaded again");
		});
		expect(runtime.readProcessIdentity(4201)).toEqual({ pid: 4201, startTimeTicks: processInfo.startTimeTicks });
		expect(native.require).toHaveBeenCalledTimes(1);
		expect(native.readProcessInfo).toHaveBeenNthCalledWith(1, 4200);
		expect(native.readProcessInfo).toHaveBeenNthCalledWith(2, 4201);
	});

	test("propagates MODULE_NOT_FOUND through the liveness check instead of reporting a dead process", async () => {
		const missingBinding = Object.assign(new Error("Cannot find module process-info.node"), {
			code: "MODULE_NOT_FOUND",
		});
		native.require.mockImplementation(() => {
			throw missingBinding;
		});
		const runtime = await vi.importActual<typeof RuntimeProcess>("../src/core/runtime-process.ts");

		expect(() => runtime.isProcessIdentityAlive({ pid: 4200, startTimeTicks: processInfo.startTimeTicks })).toThrow(
			expect.objectContaining({ code: "MODULE_NOT_FOUND", message: missingBinding.message }),
		);
		expect(native.readProcessInfo).not.toHaveBeenCalled();
	});

	test.each([
		{ label: "null", exported: null },
		{ label: "undefined", exported: undefined },
		{ label: "primitive", exported: "not a binding" },
		{ label: "missing reader", exported: {} },
		{ label: "non-callable reader", exported: { readProcessInfo: 123 } },
	])("rejects a $label native export", async ({ exported }) => {
		native.require.mockReturnValue(exported);
		const runtime = await vi.importActual<typeof RuntimeProcess>("../src/core/runtime-process.ts");

		expect(() => runtime.readProcessIdentity(4200)).toThrow(
			`Invalid Darwin process binding: ${join(packageDir, "native", "darwin", "prebuilds", "darwin-arm64", "process-info.node")}`,
		);
		expect(native.readProcessInfo).not.toHaveBeenCalled();
	});

	test.each([
		{ label: "null", returned: null },
		{ label: "primitive", returned: 4200 },
		{ label: "missing fields", returned: { pid: 4200 } },
		{ label: "wrong PID", returned: { ...processInfo, pid: 4201 } },
		{ label: "non-numeric marker", returned: { ...processInfo, startTimeTicks: "123456" } },
		{ label: "negative marker", returned: { ...processInfo, startTimeTicks: -1 } },
		{ label: "fractional marker", returned: { ...processInfo, startTimeTicks: 1.5 } },
		{ label: "unsafe marker", returned: { ...processInfo, startTimeTicks: Number.MAX_SAFE_INTEGER + 1 } },
		{ label: "NaN marker", returned: { ...processInfo, startTimeTicks: Number.NaN } },
		{ label: "negative group", returned: { ...processInfo, processGroupId: -1 } },
		{ label: "fractional group", returned: { ...processInfo, processGroupId: 1.5 } },
		{ label: "unsafe group", returned: { ...processInfo, processGroupId: Number.MAX_SAFE_INTEGER + 1 } },
		{ label: "non-numeric group", returned: { ...processInfo, processGroupId: "5300" } },
		{ label: "unknown state", returned: { ...processInfo, state: "S" } },
	])("rejects $label returned by the native binding", async ({ returned }) => {
		native.readProcessInfo.mockReturnValue(returned);
		const runtime = await vi.importActual<typeof RuntimeProcess>("../src/core/runtime-process.ts");

		expect(() => runtime.readProcessIdentity(4200)).toThrow("Invalid native process information for PID 4200");
	});

	test("rejects unsupported Darwin architecture before requiring a binding", async () => {
		vi.stubGlobal("process", { ...hostProcess, platform: "darwin", arch: "riscv64" });
		const runtime = await vi.importActual<typeof RuntimeProcess>("../src/core/runtime-process.ts");

		expect(() => runtime.readProcessIdentity(4200)).toThrow("Unsupported Darwin process architecture: riscv64");
		expect(native.require).not.toHaveBeenCalled();
	});
});
