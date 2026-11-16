import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";

// Ported from upstream #12088: a signal-terminated command reported exit code 0.
describe.skipIf(process.platform === "win32")("execCommand signal termination", () => {
	const idle = ["-e", "setInterval(() => {}, 1000)"];

	it("reports 128 + SIGTERM for a timeout", async () => {
		const result = await execCommand(process.execPath, idle, process.cwd(), { timeout: 100 });

		expect(result).toMatchObject({ code: 143, killed: true });
	});

	it("reports 128 + SIGTERM for an abort", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const result = await execCommand(process.execPath, idle, process.cwd(), { signal: controller.signal });

		expect(result).toMatchObject({ code: 143, killed: true });
	});

	it("reports 128 + the signal number for a command killed by someone else", async () => {
		// Not killed by pi, so `killed` is false and only the code tells this apart from success.
		const result = await execCommand(process.execPath, ["-e", 'process.kill(process.pid, "SIGKILL")'], process.cwd());

		expect(result).toMatchObject({ code: 137, killed: false });
	});

	it("force-kills a command that ignores SIGTERM after the grace period", async () => {
		const script = 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);';
		const result = await execCommand(process.execPath, ["-e", script], process.cwd(), { timeout: 200 });

		expect(result).toMatchObject({ code: 137, killed: true, stdout: "ready" });
	}, 10_000);
});
