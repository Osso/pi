import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const schedulerSuite = fileURLToPath(
	new URL("./fixtures/periodic-checks/test_periodic_scheduler.mjs", import.meta.url),
);

it("survives a real Git timeout in the timer and dispatches on a later tick", async () => {
	const fixture = fileURLToPath(new URL("./fixtures/periodic-checks/periodic_scheduler_timeout.mjs", import.meta.url));
	const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", fixture], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, output }));
	});
	expect(result.code, result.output).toBe(0);
}, 20000);

it("preserves the complete periodic checklist scheduler and dispatch behavior", async () => {
	const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", "--test", schedulerSuite], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, output }));
	});

	expect(result.code, result.output).toBe(0);
});
