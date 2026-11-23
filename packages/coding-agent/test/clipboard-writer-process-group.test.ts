import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "../src/utils/clipboard.ts";

function processGroupOf(pid: number): string {
	return execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf-8" }).trim();
}

async function waitForFile(path: string): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (existsSync(path)) {
			const content = readFileSync(path, "utf-8").trim();
			if (content) return content;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`${path} was not written`);
}

// Ctrl+Z sends SIGTSTP to pi's whole process group; a clipboard owner left in it stops with pi (#11179).
describe.skipIf(process.platform !== "linux")("clipboard writer process group", () => {
	let binDir: string;

	beforeEach(() => {
		binDir = mkdtempSync(join(tmpdir(), "pi-clipboard-pgid-"));
		vi.stubEnv("SSH_CONNECTION", "");
		vi.stubEnv("SSH_CLIENT", "");
		vi.stubEnv("MOSH_CONNECTION", "");
		vi.stubEnv("TERMUX_VERSION", "");
		vi.stubEnv("PATH", `${binDir}:${process.env.PATH}`);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(binDir, { recursive: true, force: true });
	});

	function installWriter(name: string): string {
		const record = join(binDir, `${name}.pgid`);
		writeFileSync(join(binDir, name), `#!/bin/sh\ncat >/dev/null\nps -o pgid= -p $$ > '${record}'\n`);
		chmodSync(join(binDir, name), 0o755);
		return record;
	}

	it("runs wl-copy outside pi's process group", async () => {
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-test");
		const record = installWriter("wl-copy");

		await copyToClipboard("text");

		expect(await waitForFile(record)).not.toBe(processGroupOf(process.pid));
	});

	it("falls back to xclip when wl-copy fails", async () => {
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-test");
		vi.stubEnv("DISPLAY", ":99");
		writeFileSync(join(binDir, "wl-copy"), "#!/bin/sh\ncat >/dev/null\nexit 1\n");
		chmodSync(join(binDir, "wl-copy"), 0o755);
		const copied = join(binDir, "xclip.out");
		writeFileSync(join(binDir, "xclip"), `#!/bin/sh\ncat > '${copied}'\n`);
		chmodSync(join(binDir, "xclip"), 0o755);

		await copyToClipboard("fallback text");

		expect(await waitForFile(copied)).toBe("fallback text");
	});

	it("runs xclip outside pi's process group", async () => {
		vi.stubEnv("WAYLAND_DISPLAY", "");
		vi.stubEnv("XDG_SESSION_TYPE", "x11");
		vi.stubEnv("DISPLAY", ":99");
		const record = installWriter("xclip");

		await copyToClipboard("text");

		expect(await waitForFile(record)).not.toBe(processGroupOf(process.pid));
	});
});
