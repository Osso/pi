import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	extractRemoteRepositoryIdentity,
	extractRemoteRepositoryName,
	resolveSupervisorProject,
	resolveSupervisorProjectForCwd,
	type SupervisorProjectConfig,
} from "../src/supervisor/project-resolver.ts";

const config: SupervisorProjectConfig = {
	globalcomix: {
		remotes: ["globalcomix", "globalcomix-api", "globalcomix-web"],
		roots: ["/syncthing/Sync/Projects/globalcomix"],
	},
	mangahelpers: {
		remotes: ["mangahelpers", "mangahelpers-worker"],
		roots: ["/syncthing/Sync/Projects/mangahelpers"],
	},
	"world-of-osso": {
		remotes: ["world-of-osso", "sentinel", "appfw"],
		roots: ["/syncthing/Sync/Projects/system"],
	},
};

describe("Supervisor project resolver", () => {
	it("uses the configured project family for a repository below a metarepo root", () => {
		expect(
			resolveSupervisorProject({
				config,
				cwd: "/syncthing/Sync/Projects/globalcomix/services/api",
				remoteRepositoryNames: ["unmapped-service"],
			}),
		).toBe("globalcomix");
	});

	it("groups multiple repositories by configured remote repository names", () => {
		expect(
			resolveSupervisorProject({
				config,
				cwd: "/worktrees/manga-worker",
				remoteRepositoryNames: ["mangahelpers-worker"],
			}),
		).toBe("mangahelpers");
		expect(
			resolveSupervisorProject({
				config,
				cwd: "/worktrees/sentinel",
				remoteRepositoryNames: ["sentinel"],
			}),
		).toBe("world-of-osso");
	});

	it("falls back from the first remote repository name to the directory basename", () => {
		expect(resolveSupervisorProject({ config: {}, cwd: "/repos/pi", remoteRepositoryNames: ["pi-mono"] })).toBe(
			"pi-mono",
		);
		expect(resolveSupervisorProject({ config: {}, cwd: "/repos/pi", remoteRepositoryNames: [] })).toBe("pi");
	});

	it("falls back to the repository root name from a subdirectory of a repository without remotes", () => {
		const parent = mkdtempSync(join(tmpdir(), "pi-supervisor-project-"));
		try {
			const repository = join(parent, "example-repo");
			mkdirSync(join(repository, "src"), { recursive: true });
			expect(spawnSync("git", ["init", "-q"], { cwd: repository }).status).toBe(0);

			expect(resolveSupervisorProjectForCwd(join(repository, "src"), join(parent, "kb"))).toBe("example-repo");
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("distinguishes repositories with the same basename by owner identity", () => {
		const ambiguousConfig: SupervisorProjectConfig = {
			globalcomix: { remotes: ["Globalcomix/ops"] },
			mangahelpers: { remotes: ["mangahelpers/ops"] },
		};

		expect(
			resolveSupervisorProject({
				config: ambiguousConfig,
				cwd: "/worktrees/ops",
				remoteRepositoryNames: ["MangaHelpers/Ops", "ops"],
			}),
		).toBe("mangahelpers");
	});

	it("extracts repository identities and names from SSH and HTTPS remote URLs", () => {
		expect(extractRemoteRepositoryIdentity("git@github.com:earendil-works/pi-mono.git")).toBe(
			"earendil-works/pi-mono",
		);
		expect(extractRemoteRepositoryIdentity("https://github.com/earendil-works/pi-mono.git")).toBe(
			"earendil-works/pi-mono",
		);
		expect(extractRemoteRepositoryName("git@github.com:earendil-works/pi-mono.git")).toBe("pi-mono");
		expect(extractRemoteRepositoryName("https://github.com/earendil-works/pi-mono.git")).toBe("pi-mono");
	});
});
