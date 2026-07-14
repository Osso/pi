import { describe, expect, it } from "vitest";
import {
	extractRemoteRepositoryIdentity,
	extractRemoteRepositoryName,
	resolveSupervisorProject,
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
