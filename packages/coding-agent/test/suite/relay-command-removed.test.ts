import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("fails `pi relay serve` from a pre-hub-link host without starting a session", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-relay-removed-"));
	try {
		const sessionDir = join(dir, "sessions");
		const result = spawnSync(
			process.execPath,
			["--experimental-strip-types", join(import.meta.dirname, "../../src/cli.ts"), "relay", "serve"],
			{
				input: "",
				encoding: "utf8",
				timeout: 60_000,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: join(dir, "agent"),
					PI_CODING_AGENT_STATE_DIR: join(dir, "agent"),
					PI_CODING_AGENT_SESSION_DIR: sessionDir,
					PI_OFFLINE: "1",
				},
			},
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("pi relay was removed");
		expect(readdirSync(dir)).not.toContain("sessions");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
