import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProvidedContext } from "vitest";
import { ENV_STATE_DIR } from "../src/config.ts";

interface VitestGlobalSetupProject {
	provide<T extends keyof ProvidedContext & string>(key: T, value: ProvidedContext[T]): void;
}

export default function isolateVitestState(project: VitestGlobalSetupProject): () => void {
	const previousStateDir = process.env[ENV_STATE_DIR];
	const stateDir = mkdtempSync(join(tmpdir(), "pi-vitest-state-"));
	const compileCacheRoot = mkdtempSync(join(tmpdir(), "pi-vitest-headless-compile-cache-"));
	project.provide("headlessCompileCacheRoot", compileCacheRoot);
	process.env[ENV_STATE_DIR] = stateDir;

	return () => {
		try {
			rmSync(stateDir, { recursive: true, force: true });
		} finally {
			try {
				rmSync(compileCacheRoot, { recursive: true, force: true });
			} finally {
				if (previousStateDir === undefined) {
					delete process.env[ENV_STATE_DIR];
				} else {
					process.env[ENV_STATE_DIR] = previousStateDir;
				}
			}
		}
	};
}
