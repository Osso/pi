import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { isVerifiedPiRuntimeProcess } from "../src/core/runtime-process.ts";

const children: ReturnType<typeof spawn>[] = [];

afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
});

it.runIf(process.platform === "linux")(
	"verifies a live process titled pi-rpc by rpc-entry as a Pi runtime",
	async () => {
		const child = spawn(process.execPath, ["-e", 'process.title = "pi-rpc"; setInterval(() => {}, 1000);'], {
			stdio: "ignore",
		});
		children.push(child);
		const pid = child.pid;
		if (pid === undefined) throw new Error("child process did not start");
		await vi.waitFor(() => expect(readFileSync(`/proc/${pid}/cmdline`, "utf8")).toMatch(/^pi-rpc/), {
			timeout: 5_000,
		});

		expect(isVerifiedPiRuntimeProcess(pid)).toBe(true);
	},
);
