/**
 * Compiled binaries bake the build machine's photon-node directory into the bundle.
 * For other users that path can exist but be unreadable (EACCES), so Photon must load
 * the photon_rs_bg.wasm copied next to the executable instead.
 */

import type * as FsModule from "node:fs";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resizeImageInProcess } from "../src/utils/image-resize-core.ts";

vi.mock("../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	isBunBinary: true,
}));

const require = createRequire(import.meta.url);
const fs = require("fs") as typeof FsModule;

// 1x1 RGB PNG
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

describe("photon wasm loading in compiled binaries", () => {
	const originalExecPath = process.execPath;
	let installDir: string | undefined;

	afterEach(() => {
		vi.restoreAllMocks();
		process.execPath = originalExecPath;
		if (installDir) rmSync(installDir, { recursive: true, force: true });
	});

	it("decodes images when the baked build path is unreadable", async () => {
		const bakedWasm = join(dirname(require.resolve("@silvia-odwyer/photon-node")), "photon_rs_bg.wasm");
		installDir = mkdtempSync(join(tmpdir(), "pi-photon-install-"));
		copyFileSync(bakedWasm, join(installDir, "photon_rs_bg.wasm"));
		process.execPath = join(installDir, "pi");

		const realReadFileSync = fs.readFileSync.bind(fs);
		vi.spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
			if (args[0] === bakedWasm) {
				throw Object.assign(new Error(`EACCES: permission denied, open '${bakedWasm}'`), { code: "EACCES" });
			}
			return realReadFileSync(...args);
		}) as typeof fs.readFileSync);

		const result = await resizeImageInProcess(Buffer.from(PNG_1x1, "base64"), "image/png");

		expect(result).toMatchObject({ data: PNG_1x1, mimeType: "image/png", width: 1, height: 1 });
	});
});
