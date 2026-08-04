import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_STATE_DIR } from "../src/config.ts";

export default function isolateVitestState(): () => void {
	const previousStateDir = process.env[ENV_STATE_DIR];
	const stateDir = mkdtempSync(join(tmpdir(), "pi-vitest-state-"));
	process.env[ENV_STATE_DIR] = stateDir;

	return () => {
		try {
			rmSync(stateDir, { recursive: true, force: true });
		} finally {
			if (previousStateDir === undefined) {
				delete process.env[ENV_STATE_DIR];
			} else {
				process.env[ENV_STATE_DIR] = previousStateDir;
			}
		}
	};
}
