import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { expect, it, vi } from "vitest";
import { ENV_STATE_DIR } from "../src/config.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getControlDbPath } from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";

const REFRESH_FAILURE = "Failed to refresh runtime mailbox listeners:";

it("does not print a busy control DB on the listener heartbeat, but still reports other refresh failures", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
	const agentDir = mkdtempSync(join(tmpdir(), "pi-heartbeat-contention-"));
	const previousStateDir = process.env[ENV_STATE_DIR];
	process.env[ENV_STATE_DIR] = agentDir;
	const faux = registerFauxProvider();
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	const holder = createSqliteDatabase(getControlDbPath(agentDir));
	try {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const services = await createAgentSessionServices({
			agentDir,
			authStorage,
			cwd: agentDir,
			resourceLoaderOptions: { noPromptTemplates: true, noSkills: true, noThemes: true },
		});
		const { session } = await createAgentSessionFromServices({
			model: faux.getModel(),
			services,
			sessionManager: SessionManager.create(agentDir, join(agentDir, "sessions")),
		});
		try {
			holder.exec("BEGIN IMMEDIATE");
			try {
				vi.advanceTimersByTime(60_000);
			} finally {
				holder.exec("ROLLBACK");
			}
			expect(errors.mock.calls.filter(([message]) => message === REFRESH_FAILURE)).toEqual([]);

			holder.exec(`
				CREATE TRIGGER fail_listener_insert BEFORE INSERT ON runtime_mailbox_listeners
				BEGIN SELECT RAISE(ABORT, 'forced listener refresh failure'); END;
				CREATE TRIGGER fail_listener_update BEFORE UPDATE ON runtime_mailbox_listeners
				BEGIN SELECT RAISE(ABORT, 'forced listener refresh failure'); END;
			`);
			vi.advanceTimersByTime(60_000);
			const failures = errors.mock.calls.filter(([message]) => message === REFRESH_FAILURE);
			expect(failures).toHaveLength(1);
			expect(String(failures[0]?.[1])).toContain("forced listener refresh failure");
			holder.exec("DROP TRIGGER fail_listener_insert; DROP TRIGGER fail_listener_update;");
		} finally {
			session.dispose();
		}
	} finally {
		holder.close();
		errors.mockRestore();
		vi.useRealTimers();
		faux.unregister();
		if (previousStateDir === undefined) delete process.env[ENV_STATE_DIR];
		else process.env[ENV_STATE_DIR] = previousStateDir;
		rmSync(agentDir, { force: true, recursive: true });
	}
}, 60_000);
