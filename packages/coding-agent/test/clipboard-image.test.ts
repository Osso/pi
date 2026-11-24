import type { SpawnSyncReturns } from "child_process";
import { writeFileSync } from "fs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { readClipboardImage } from "../src/utils/clipboard-image.ts";

const mocks = vi.hoisted(() => {
	return {
		spawnSync: vi.fn<(command: string, args: string[], options: unknown) => SpawnSyncReturns<Buffer>>(),
		clipboard: {
			hasImage: vi.fn<() => boolean>(),
			getImageBinary: vi.fn<() => Promise<Uint8Array | null>>(),
		},
	};
});

vi.mock("child_process", () => {
	return {
		spawnSync: mocks.spawnSync,
	};
});

vi.mock("../src/utils/clipboard-native.js", () => {
	return {
		clipboard: mocks.clipboard,
	};
});

function spawnOk(stdout: Buffer): SpawnSyncReturns<Buffer> {
	return {
		pid: 123,
		output: [Buffer.alloc(0), stdout, Buffer.alloc(0)],
		stdout,
		stderr: Buffer.alloc(0),
		status: 0,
		signal: null,
	};
}

function spawnError(error: Error): SpawnSyncReturns<Buffer> {
	return {
		pid: 123,
		output: [Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0)],
		stdout: Buffer.alloc(0),
		stderr: Buffer.alloc(0),
		status: null,
		signal: null,
		error,
	};
}

describe("readClipboardImage", () => {
	beforeEach(() => {
		mocks.spawnSync.mockReset();
		mocks.clipboard.hasImage.mockReset();
		mocks.clipboard.getImageBinary.mockReset();
	});

	test("Wayland: uses wl-paste and never calls clipboard", async () => {
		mocks.clipboard.hasImage.mockImplementation(() => {
			throw new Error("clipboard.hasImage should not be called on Wayland");
		});

		mocks.spawnSync.mockImplementation((command, args, _options) => {
			if (command === "wl-paste" && args[0] === "--list-types") {
				return spawnOk(Buffer.from("text/plain\nimage/png\n", "utf-8"));
			}
			if (command === "wl-paste" && args[0] === "--type") {
				return spawnOk(Buffer.from([1, 2, 3]));
			}
			throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
		});

		const result = await readClipboardImage({ platform: "linux", env: { WAYLAND_DISPLAY: "1" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([1, 2, 3]);
	});

	test("Wayland: falls back to xclip when wl-paste is missing", async () => {
		mocks.clipboard.hasImage.mockImplementation(() => {
			throw new Error("clipboard.hasImage should not be called on Wayland");
		});

		const enoent = new Error("spawn ENOENT");
		(enoent as { code?: string }).code = "ENOENT";

		mocks.spawnSync.mockImplementation((command, args, _options) => {
			if (command === "wl-paste") {
				return spawnError(enoent);
			}

			if (command === "xclip" && args.includes("TARGETS")) {
				return spawnOk(Buffer.from("image/png\n", "utf-8"));
			}

			if (command === "xclip" && args.includes("image/png")) {
				return spawnOk(Buffer.from([9, 8]));
			}

			return spawnOk(Buffer.alloc(0));
		});

		const result = await readClipboardImage({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([9, 8]);
	});

	test.each([
		["lists no image type", "text/plain\n", Buffer.alloc(0)],
		["returns an empty image", "image/png\n", Buffer.alloc(0)],
	])("Wayland: does not paste a stale X11 image when wl-paste %s", async (_case, types, bytes) => {
		mocks.spawnSync.mockImplementation((command, args) => {
			if (command === "wl-paste") return spawnOk(args[0] === "--list-types" ? Buffer.from(types) : bytes);
			if (args.includes("TARGETS")) return spawnOk(Buffer.from("image/png\n"));
			return spawnOk(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		});

		const result = await readClipboardImage({
			platform: "linux",
			env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
		});

		expect(result).toBeNull();
	});

	test.each([
		["TARGETS fails", undefined],
		["TARGETS lists only image/png, which fails", "image/png\n"],
	])("Wayland xclip fallback does not probe unadvertised image types when %s", async (_case, targets) => {
		const enoent = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
		const probed: string[] = [];
		mocks.spawnSync.mockImplementation((command, args) => {
			if (command === "wl-paste") return spawnError(enoent);
			if (args.includes("TARGETS")) {
				return targets === undefined ? spawnError(new Error("no owner")) : spawnOk(Buffer.from(targets));
			}
			probed.push(args[3]);
			// The owner answers every other target with its text.
			return args[3] === "image/png" ? spawnError(new Error("conversion failed")) : spawnOk(Buffer.from("hello"));
		});

		const result = await readClipboardImage({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } });

		expect(result).toBeNull();
		expect(probed).toEqual(targets === undefined ? [] : ["image/png"]);
	});

	test("WSL: passes PowerShell path directly instead of through a custom env var", async () => {
		mocks.clipboard.hasImage.mockImplementation(() => {
			throw new Error("clipboard.hasImage should not be called before PowerShell on WSL");
		});

		let tmpFile: string | undefined;
		mocks.spawnSync.mockImplementation((command, args, options) => {
			if (command === "wl-paste" || command === "xclip") {
				return spawnOk(Buffer.alloc(0));
			}

			if (command === "wslpath") {
				tmpFile = args[1];
				return spawnOk(Buffer.from("C:\\Users\\O'Hare\\clip.png\n", "utf-8"));
			}

			if (command === "powershell.exe") {
				const spawnOptions = options as { env?: NodeJS.ProcessEnv };
				expect(spawnOptions.env?.PI_WSL_CLIPBOARD_IMAGE_PATH).toBeUndefined();
				expect(args[2]).toContain("$path = 'C:\\Users\\O''Hare\\clip.png'");
				if (!tmpFile) {
					throw new Error("wslpath should be called before powershell.exe");
				}
				writeFileSync(tmpFile, Buffer.from([4, 5, 6]));
				return spawnOk(Buffer.from("ok\n", "utf-8"));
			}

			throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
		});

		const result = await readClipboardImage({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([4, 5, 6]);
	});

	test("Headless Linux: reads uploaded PNG from wl-paste without a display", async () => {
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
			"base64",
		);
		mocks.spawnSync.mockImplementation((command, args) => {
			if (command === "wl-paste" && args[0] === "--list-types") {
				return spawnOk(Buffer.from("image/png\n"));
			}
			if (command === "wl-paste" && args[0] === "--type") {
				return spawnOk(png);
			}
			throw new Error(`Unexpected clipboard command: ${command} ${args.join(" ")}`);
		});

		const result = await readClipboardImage({ platform: "linux", env: { XDG_SESSION_TYPE: "tty" } });
		expect(result?.mimeType).toBe("image/png");
		expect(Buffer.from(result?.bytes ?? [])).toEqual(png);
	});

	test("X11: uses clipboard", async () => {
		mocks.spawnSync.mockImplementation(() => {
			throw new Error("spawnSync should not be called for non-Wayland sessions");
		});

		mocks.clipboard.hasImage.mockReturnValue(true);
		mocks.clipboard.getImageBinary.mockResolvedValue(new Uint8Array([7]));

		const result = await readClipboardImage({ platform: "linux", env: { DISPLAY: ":0" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([7]);
	});

	test("X11: returns null when clipboard has no image", async () => {
		mocks.spawnSync.mockImplementation(() => {
			throw new Error("spawnSync should not be called for non-Wayland sessions");
		});

		mocks.clipboard.hasImage.mockReturnValue(false);

		const result = await readClipboardImage({ platform: "linux", env: { DISPLAY: ":0" } });
		expect(result).toBeNull();
	});
});
