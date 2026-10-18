import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const originalPixels = [255, 0, 0, 255, 0, 0, 255, 255];
const flippedPixels = [0, 0, 255, 255, 255, 0, 0, 255];
// Little-endian TIFF with one SHORT orientation entry: mirror horizontally (2).
const tiff = Buffer.from("49492a0008000000010012010300010000000200000000000000", "hex");

function orientPixels(bytes: Uint8Array): number[] {
	// A test-runner timeout cannot interrupt a synchronous parser loop. Kill the
	// isolated process instead, so a regression fails without hanging the suite.
	const script = `
		import * as photon from "@silvia-odwyer/photon-node";
		import { applyExifOrientation } from ${JSON.stringify(new URL("../src/utils/exif-orientation.ts", import.meta.url).href)};
		const image = new photon.PhotonImage(Uint8Array.from(${JSON.stringify(originalPixels)}), 2, 1);
		const oriented = applyExifOrientation(photon, image, Buffer.from(process.argv[1], "hex"));
		try {
			console.log(JSON.stringify(Array.from(oriented.get_raw_pixels())));
		} finally {
			if (oriented !== image) oriented.free();
			image.free();
		}
	`;
	const result = spawnSync(
		process.execPath,
		["--input-type=module", "--eval", script, Buffer.from(bytes).toString("hex")],
		{
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			encoding: "utf8",
			timeout: 2000,
			killSignal: "SIGKILL",
		},
	);
	expect(result.error, "EXIF parsing must finish before the subprocess timeout").toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout);
}

function webpChunk(id: string, data: Buffer, size = data.length): Buffer {
	const header = Buffer.alloc(8);
	header.write(id);
	header.writeUInt32LE(size, 4);
	return Buffer.concat([header, data]);
}

function webp(...chunks: Buffer[]): Buffer {
	const body = Buffer.concat(chunks);
	const header = Buffer.from("RIFF\0\0\0\0WEBP", "ascii");
	header.writeUInt32LE(4 + body.length, 4);
	return Buffer.concat([header, body]);
}

describe("EXIF orientation", () => {
	it.each([0xfffffff8, 0xfffffff7, 0xfffffff6])("terminates on WebP chunk size 0x%s", (size) => {
		const bytes = webp(webpChunk("JUNK", Buffer.alloc(0), size));
		expect(orientPixels(bytes)).toEqual(originalPixels);
	});

	it.each([0x80000000, 0xfffffff8, 0xffffffff])("rejects oversized unsigned WebP EXIF chunk size 0x%s", (size) => {
		expect(orientPixels(webp(webpChunk("EXIF", tiff, size)))).toEqual(originalPixels);
	});

	it("rejects a chunk whose required odd-byte padding exceeds the buffer", () => {
		const unpaddedTiff = Buffer.concat([tiff, Buffer.from([0])]);
		expect(orientPixels(webp(webpChunk("EXIF", unpaddedTiff)))).toEqual(originalPixels);
	});

	it.each([tiff, Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff])])(
		"applies valid WebP orientation with or without the Exif prefix (%#)",
		(exif) => {
			expect(orientPixels(webp(webpChunk("EXIF", exif)))).toEqual(flippedPixels);
		},
	);

	it("advances over empty chunks and odd chunks with padding", () => {
		const bytes = webp(
			webpChunk("JUNK", Buffer.alloc(0)),
			webpChunk("VP8 ", Buffer.from([0])),
			Buffer.from([0]),
			webpChunk("EXIF", tiff),
		);
		expect(orientPixels(bytes)).toEqual(flippedPixels);
	});

	it("rejects a truncated WebP chunk", () => {
		expect(orientPixels(webp(webpChunk("EXIF", tiff, tiff.length + 2)))).toEqual(originalPixels);
	});

	it("applies valid JPEG orientation after fill markers and an empty segment", () => {
		const exif = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
		const app1 = Buffer.from([0xff, 0xe1, 0, exif.length + 2]);
		const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xe0, 0, 2]), app1, exif]);
		expect(orientPixels(bytes)).toEqual(flippedPixels);
	});

	it("returns unchanged pixels for a truncated JPEG segment", () => {
		expect(orientPixels(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]))).toEqual(originalPixels);
	});

	it("terminates on an invalid signed TIFF IFD offset", () => {
		const invalidTiff = Buffer.from("49492a00f8ffffff", "hex");
		expect(orientPixels(webp(webpChunk("EXIF", invalidTiff)))).toEqual(originalPixels);
	});
});
