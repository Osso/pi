import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

export const DEFAULT_SUPERVISOR_KB_DIR = "/syncthing/Sync/KB";

export interface SupervisorProjectMapping {
	remotes?: string[];
	roots?: string[];
}

export type SupervisorProjectConfig = Record<string, SupervisorProjectMapping>;

export interface ResolveSupervisorProjectInput {
	config: SupervisorProjectConfig;
	cwd: string;
	remoteRepositoryNames: string[];
}

export function extractRemoteRepositoryIdentity(remoteUrl: string): string | undefined {
	const normalized = remoteUrl
		.trim()
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, "")
		.replace(/^[^@]+@[^:]+:/, "");
	const segments = normalized.split("/").filter(Boolean);
	return segments.length >= 2 ? segments.slice(-2).join("/") : segments[0];
}

export function extractRemoteRepositoryName(remoteUrl: string): string | undefined {
	return extractRemoteRepositoryIdentity(remoteUrl)?.split("/").at(-1);
}

export function resolveSupervisorProjectForCwd(cwd: string, kbDir: string): string {
	const config = readSupervisorProjectConfig(join(kbDir, "memory", "supervisor", "projects.json"));
	return resolveSupervisorProject({ config, cwd, remoteRepositoryNames: readRemoteRepositoryNames(cwd) });
}

export function readSupervisorProjectConfig(path: string): SupervisorProjectConfig {
	if (!existsSync(path)) return {};
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(parsed)) throw new Error(`Supervisor project config must be an object: ${path}`);
	return Object.fromEntries(
		Object.entries(parsed).map(([projectId, value]) => {
			if (!isRecord(value)) throw new Error(`Supervisor project mapping must be an object: ${projectId}`);
			return [projectId, { remotes: readStringArray(value.remotes), roots: readStringArray(value.roots) }];
		}),
	);
}

export function resolveSupervisorProject(input: ResolveSupervisorProjectInput): string {
	const rootMatch = findProjectByRoot(input.config, input.cwd);
	if (rootMatch) return rootMatch;

	const remoteMatch = findProjectByRemote(input.config, input.remoteRepositoryNames);
	if (remoteMatch) return remoteMatch;

	return input.remoteRepositoryNames[0]?.split("/").at(-1)?.toLowerCase() ?? basename(resolve(input.cwd));
}

function findProjectByRoot(config: SupervisorProjectConfig, cwd: string): string | undefined {
	const resolvedCwd = resolve(cwd);
	return Object.entries(config).find(([, mapping]) =>
		mapping.roots?.some((root) => isPathWithinRoot(resolvedCwd, resolve(root))),
	)?.[0];
}

function findProjectByRemote(config: SupervisorProjectConfig, remoteRepositoryNames: string[]): string | undefined {
	const remoteNames = new Set(remoteRepositoryNames.map((remote) => remote.toLowerCase()));
	return Object.entries(config).find(([, mapping]) =>
		mapping.remotes?.some((remote) => remoteNames.has(remote.toLowerCase())),
	)?.[0];
}

function readRemoteRepositoryNames(cwd: string): string[] {
	const result = spawnSync("git", ["remote", "-v"], { cwd, encoding: "utf8" });
	if (result.status !== 0) return [];
	const remoteUrls = result.stdout
		.split("\n")
		.map((line) => line.trim().split(/\s+/)[1])
		.filter((remoteUrl): remoteUrl is string => Boolean(remoteUrl));
	return [
		...new Set(
			remoteUrls.flatMap((remoteUrl) =>
				[extractRemoteRepositoryIdentity(remoteUrl), extractRemoteRepositoryName(remoteUrl)].filter(
					(value): value is string => value !== undefined,
				),
			),
		),
	];
}

function readStringArray(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error("Supervisor project mapping values must be string arrays");
	}
	return value;
}

function isPathWithinRoot(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
