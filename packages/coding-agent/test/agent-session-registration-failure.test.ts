import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { expect, it, vi } from "vitest";
import { ENV_STATE_DIR } from "../src/config.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getControlDbPath, listSessionHealth } from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";

it("does not emit session_start or retain timers when runtime listener registration fails", async () => {
	vi.useFakeTimers();
	const agentDir = mkdtempSync(join(tmpdir(), "pi-listener-registration-failure-"));
	const previousStateDir = process.env[ENV_STATE_DIR];
	process.env[ENV_STATE_DIR] = agentDir;
	const faux = registerFauxProvider();
	let sessionStartCount = 0;
	try {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const services = await createAgentSessionServices({
			agentDir,
			authStorage,
			cwd: agentDir,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi) => {
						pi.on("session_start", () => {
							sessionStartCount += 1;
						});
					},
				],
				noPromptTemplates: true,
				noSkills: true,
				noThemes: true,
			},
		});
		const controlDbPath = getControlDbPath(agentDir);
		listSessionHealth(controlDbPath);
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`
				CREATE TRIGGER fail_runtime_listener_insert
				BEFORE INSERT ON runtime_mailbox_listeners
				BEGIN SELECT RAISE(ABORT, 'forced listener registration failure'); END;
			`);
		} finally {
			db.close();
		}

		await expect(
			createAgentSessionFromServices({
				model: faux.getModel(),
				services,
				sessionManager: SessionManager.create(agentDir),
			}),
		).rejects.toThrow(/forced listener registration failure/);
		expect(sessionStartCount).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.useRealTimers();
		faux.unregister();
		if (previousStateDir === undefined) {
			delete process.env[ENV_STATE_DIR];
		} else {
			process.env[ENV_STATE_DIR] = previousStateDir;
		}
		rmSync(agentDir, { force: true, recursive: true });
	}
});
