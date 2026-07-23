import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { getAgentDir } from "../config.ts";
import {
	type DetachedArtifactRetentionCandidate,
	selectDetachedArtifactDirectoriesToDelete,
} from "./detached-job-retention.ts";
import type { AgentSnapshot } from "./multi-agent-store.ts";
import { listSessionMetadata, readMultiAgentState } from "./session-control-db.ts";

const DETACHED_ARTIFACT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1_000;
const DETACHED_ARTIFACT_MAX_BYTES = 2 * 1024 ** 3;
const DETACHED_OUTPUT_LABELS = new Set(["Bash output", "Pyrun output"]);
const DELETED_PATH_SUFFIX = " (deleted)";

export interface DetachedJobCleanupResult {
	deletedBytes: number;
	deletedDirectories: string[];
	errors: string[];
	retainedBytes: number;
	skippedReason?: string;
}

interface DetachedJobCleanupOptions {
	artifactRoot: string;
	now?: number;
	onDirectoryQuarantined?: (quarantinePath: string) => void;
}

export function cleanupDetachedJobArtifacts(
	controlDbPath: string,
	options: DetachedJobCleanupOptions,
): DetachedJobCleanupResult {
	const processReferences = readLinuxProcessReferences();
	if (!processReferences) return emptyCleanupResult("live process reference inspection requires Linux /proc");
	const errors: string[] = [];
	const candidates = collectTerminalArtifactCandidates(controlDbPath, options.artifactRoot, processReferences, errors);
	const pathsToDelete = selectDetachedArtifactDirectoriesToDelete(candidates, {
		maxAge: DETACHED_ARTIFACT_MAX_AGE_MS,
		maxBytes: DETACHED_ARTIFACT_MAX_BYTES,
		now: options.now ?? Date.now(),
	});
	return deleteSelectedArtifactDirectories(candidates, pathsToDelete, errors, options.onDirectoryQuarantined);
}

export function runDetachedJobArtifactCleanup(
	controlDbPath: string,
	artifactRoot: string = getAgentDir(),
	now = Date.now(),
): void {
	try {
		const result = cleanupDetachedJobArtifacts(controlDbPath, { artifactRoot, now });
		for (const error of result.errors) console.error(`Detached artifact cleanup: ${error}`);
	} catch (error) {
		console.error(`Detached artifact cleanup failed: ${errorMessage(error)}`);
	}
}

function emptyCleanupResult(skippedReason: string): DetachedJobCleanupResult {
	return { deletedBytes: 0, deletedDirectories: [], errors: [], retainedBytes: 0, skippedReason };
}

function deleteSelectedArtifactDirectories(
	candidates: readonly DetachedArtifactRetentionCandidate[],
	pathsToDelete: readonly string[],
	errors: string[],
	onDirectoryQuarantined?: (quarantinePath: string) => void,
): DetachedJobCleanupResult {
	const candidatesByPath = new Map(candidates.map((candidate) => [candidate.directoryPath, candidate]));
	const deletedDirectories: string[] = [];
	let deletedBytes = 0;
	for (const directoryPath of pathsToDelete) {
		const candidate = candidatesByPath.get(directoryPath);
		if (!candidate) continue;
		if (deleteUnreferencedArtifactDirectory(directoryPath, errors, onDirectoryQuarantined)) {
			deletedDirectories.push(directoryPath);
			deletedBytes += candidate.byteSize;
		}
	}
	return {
		deletedBytes,
		deletedDirectories,
		errors,
		retainedBytes: totalCandidateBytes(candidates) - deletedBytes,
	};
}

function deleteUnreferencedArtifactDirectory(
	directoryPath: string,
	errors: string[],
	onDirectoryQuarantined?: (quarantinePath: string) => void,
): boolean {
	const quarantinePath = join(dirname(directoryPath), `.cleanup-${basename(directoryPath)}-${randomUUID()}`);
	try {
		const directory = lstatSync(directoryPath);
		if (!directory.isDirectory() || directory.isSymbolicLink()) {
			errors.push(`Refused to delete non-directory detached artifact path: ${directoryPath}`);
			return false;
		}
		renameSync(directoryPath, quarantinePath);
		onDirectoryQuarantined?.(quarantinePath);
		if (quarantinedDirectoryHasLiveReference(quarantinePath)) {
			renameSync(quarantinePath, directoryPath);
			return false;
		}
		rmSync(quarantinePath, { force: true, recursive: true });
		return true;
	} catch (error) {
		restoreQuarantinedDirectory(quarantinePath, directoryPath, errors);
		if (isMissingPathError(error)) return false;
		errors.push(`Could not delete detached artifact directory ${directoryPath}: ${errorMessage(error)}`);
		return false;
	}
}

function quarantinedDirectoryHasLiveReference(quarantinePath: string): boolean {
	const processReferences = readLinuxProcessReferences();
	return !processReferences || directoryHasLiveReference(realpathSync(quarantinePath), processReferences);
}

function restoreQuarantinedDirectory(quarantinePath: string, directoryPath: string, errors: string[]): void {
	if (!existsSync(quarantinePath) || existsSync(directoryPath)) return;
	try {
		renameSync(quarantinePath, directoryPath);
	} catch (error) {
		errors.push(`Could not restore referenced detached artifact directory ${directoryPath}: ${errorMessage(error)}`);
	}
}

function totalCandidateBytes(candidates: readonly DetachedArtifactRetentionCandidate[]): number {
	return candidates.reduce((total, candidate) => total + candidate.byteSize, 0);
}

function collectTerminalArtifactCandidates(
	controlDbPath: string,
	artifactRoot: string,
	processReferences: ReadonlySet<string>,
	errors: string[],
): DetachedArtifactRetentionCandidate[] {
	const candidatesByPath = new Map<string, DetachedArtifactRetentionCandidate>();
	for (const session of listSessionMetadata(controlDbPath)) {
		const state = readMultiAgentState(controlDbPath, session.sessionPath);
		if (!state) continue;
		for (const persistedAgent of state.agents) {
			const candidate = terminalArtifactCandidate(
				persistedAgent,
				session.sessionPath,
				artifactRoot,
				processReferences,
				errors,
			);
			if (!candidate) continue;
			const existing = candidatesByPath.get(candidate.directoryPath);
			if (!existing) {
				candidatesByPath.set(candidate.directoryPath, candidate);
				continue;
			}
			candidatesByPath.set(candidate.directoryPath, { ...existing, protectedByLiveReference: true });
		}
	}
	return [...candidatesByPath.values()];
}

function terminalArtifactCandidate(
	persistedAgent: unknown,
	sessionPath: string,
	artifactRoot: string,
	processReferences: ReadonlySet<string>,
	errors: string[],
): DetachedArtifactRetentionCandidate | undefined {
	if (!persistedAgent || typeof persistedAgent !== "object" || Array.isArray(persistedAgent)) return undefined;
	const agent = persistedAgent as Partial<AgentSnapshot>;
	if (!isTerminalLifecycle(agent.lifecycle) || typeof agent.id !== "string" || typeof agent.updatedAt !== "string") {
		return undefined;
	}
	const outputPath = detachedOutputPath(agent);
	if (!outputPath) return undefined;
	const directoryPath = detachedArtifactDirectory(outputPath, sessionPath, agent.id, artifactRoot);
	if (!directoryPath) return undefined;
	const terminalAt = Date.parse(agent.updatedAt);
	if (!Number.isFinite(terminalAt)) {
		errors.push(`Invalid detached artifact terminal timestamp for ${sessionPath}#${agent.id}`);
		return undefined;
	}
	const byteSize = readDirectoryByteSize(directoryPath, errors);
	if (byteSize === undefined) return undefined;
	return {
		byteSize,
		directoryPath,
		protectedByLiveReference: directoryHasLiveReference(directoryPath, processReferences),
		terminalAt,
	};
}

function detachedOutputPath(agent: Partial<AgentSnapshot>): string | undefined {
	const fileRef = agent.result?.fileRefs?.find(
		(reference) => reference.label !== undefined && DETACHED_OUTPUT_LABELS.has(reference.label),
	);
	return fileRef?.path;
}

function detachedArtifactDirectory(
	outputPath: string,
	sessionPath: string,
	jobId: string,
	artifactRoot: string,
): string | undefined {
	if (!isAbsolute(outputPath) || basename(outputPath) !== "output.log" || !isPathSegment(jobId)) return undefined;
	const directoryPath = resolve(dirname(outputPath));
	const sessionName = basename(sessionPath, extname(sessionPath));
	if (!isPathSegment(sessionName)) return undefined;
	const expectedDirectoryPath = resolve(artifactRoot, "detached-jobs", sessionName, jobId);
	if (directoryPath !== expectedDirectoryPath) return undefined;
	try {
		const directory = lstatSync(directoryPath);
		if (!directory.isDirectory() || directory.isSymbolicLink()) return undefined;
		const canonicalDirectoryPath = realpathSync(directoryPath);
		const canonicalArtifactRoot = realpathSync(artifactRoot);
		const expectedCanonicalPath = join(canonicalArtifactRoot, "detached-jobs", sessionName, jobId);
		return canonicalDirectoryPath === expectedCanonicalPath ? canonicalDirectoryPath : undefined;
	} catch (error) {
		if (isMissingPathError(error)) return undefined;
		throw error;
	}
}

function isPathSegment(value: string): boolean {
	return value.length > 0 && value !== "." && value !== ".." && basename(value) === value;
}

function readDirectoryByteSize(directoryPath: string, errors: string[]): number | undefined {
	let byteSize = 0;
	const pendingDirectories = [directoryPath];
	try {
		while (pendingDirectories.length > 0) {
			const currentDirectory = pendingDirectories.pop();
			if (!currentDirectory) continue;
			for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
				const entryPath = join(currentDirectory, entry.name);
				if (entry.isDirectory()) {
					pendingDirectories.push(entryPath);
					continue;
				}
				byteSize += lstatSync(entryPath).size;
			}
		}
		return byteSize;
	} catch (error) {
		if (isMissingPathError(error)) return undefined;
		errors.push(`Could not measure detached artifact directory ${directoryPath}: ${errorMessage(error)}`);
		return undefined;
	}
}

function readLinuxProcessReferences(): Set<string> | undefined {
	if (process.platform !== "linux" || !existsSync("/proc")) return undefined;
	const references = new Set<string>();
	for (const processEntry of readdirSync("/proc", { withFileTypes: true })) {
		if (!processEntry.isDirectory() || !/^\d+$/.test(processEntry.name)) continue;
		const processDirectory = join("/proc", processEntry.name);
		addLinkReference(references, join(processDirectory, "cwd"));
		addLinkReference(references, join(processDirectory, "exe"));
		addDescriptorReferences(references, join(processDirectory, "fd"));
	}
	return references;
}

function addLinkReference(references: Set<string>, linkPath: string): void {
	try {
		addAbsoluteReference(references, readlinkSync(linkPath));
	} catch (error) {
		if (!isExpectedProcessReadError(error)) throw error;
	}
}

function addDescriptorReferences(references: Set<string>, descriptorDirectory: string): void {
	try {
		for (const descriptor of readdirSync(descriptorDirectory)) {
			addLinkReference(references, join(descriptorDirectory, descriptor));
		}
	} catch (error) {
		if (!isExpectedProcessReadError(error)) throw error;
	}
}

function addAbsoluteReference(references: Set<string>, value: string): void {
	const path = value.endsWith(DELETED_PATH_SUFFIX) ? value.slice(0, -DELETED_PATH_SUFFIX.length) : value;
	if (!isAbsolute(path)) return;
	try {
		references.add(realpathSync(path));
	} catch (error) {
		if (isErrorCode(error, "ENAMETOOLONG")) return;
		if (!isExpectedReferenceResolutionError(error)) throw error;
		references.add(resolve(path));
	}
}

function directoryHasLiveReference(directoryPath: string, references: ReadonlySet<string>): boolean {
	const nestedPrefix = `${directoryPath}${sep}`;
	for (const reference of references) {
		if (reference === directoryPath || reference.startsWith(nestedPrefix)) return true;
	}
	return false;
}

function isTerminalLifecycle(lifecycle: AgentSnapshot["lifecycle"] | undefined): boolean {
	return lifecycle === "completed" || lifecycle === "failed" || lifecycle === "aborted";
}

function isMissingPathError(error: unknown): boolean {
	return isErrorCode(error, "ENOENT");
}

function isExpectedReferenceResolutionError(error: unknown): boolean {
	return ["EACCES", "ENOENT", "ENOTDIR", "EPERM"].some((code) => isErrorCode(error, code));
}

function isExpectedProcessReadError(error: unknown): boolean {
	return ["EACCES", "ENOENT", "EPERM", "ESRCH"].some((code) => isErrorCode(error, code));
}

function isErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
