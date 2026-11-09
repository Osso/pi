import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { recordCredentialTrace } from "./auth-trace.ts";

function validateProfileName(name: string): void {
	if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
		throw new Error("Invalid profile name: use letters, digits, underscores or hyphens");
	}
}

export function validateAccountProfileNames(names: readonly string[]): void {
	const unique = new Set<string>();
	for (const name of names) {
		validateProfileName(name);
		if (unique.has(name)) throw new Error("Duplicate profile name");
		unique.add(name);
	}
}

/** First unattempted name in explicit order; undefined means exhausted. No wraparound. */
export function nextAccountProfile(names: readonly string[], attempted: Iterable<string>): string | undefined {
	validateAccountProfileNames(names);
	const tried = new Set(attempted);
	return names.find((name) => !tried.has(name));
}

function profilePaths(home: string, name: string) {
	validateProfileName(name);
	if (!isAbsolute(home)) throw new Error("Account profiles require an absolute home directory");
	const original = join(home, ".claude");
	const root = join(home, ".config", "pi-claude-bridge");
	const profiles = join(root, "profiles");
	const configDir = join(profiles, name);
	return {
		root,
		profiles,
		configDir,
		original,
		saved: join(original, `${name}.credentials.json`),
		isolated: join(configDir, ".credentials.json"),
		owner: join(configDir, ".credential-owner"),
		migration: join(configDir, ".credential-migration"),
	};
}

function identifyCredentialSource(
	paths: ReturnType<typeof profilePaths>,
	source: string,
): "named" | "isolated" | "active" {
	if (source === paths.saved) return "named";
	if (source === paths.isolated) return "isolated";
	return "active";
}

function inspectPath(path: string) {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function restrictDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	if (!lstatSync(path).isDirectory()) throw new Error("Account profile path must be a directory, not a symlink");
	chmodSync(path, 0o700);
}

function requireRegularFile(path: string): void {
	const stat = inspectPath(path);
	if (stat && !stat.isFile()) throw new Error("Credentials must be a regular file, not a symlink");
}

function readCredentials(path: string): string {
	requireRegularFile(path);
	const content = readFileSync(path, "utf8");
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		throw new Error("Invalid credentials: expected a nonempty JSON object");
	}
	if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
		throw new Error("Invalid credentials: expected a nonempty JSON object");
	}
	const oauth = (value as Record<string, unknown>).claudeAiOauth;
	const token =
		oauth !== null && typeof oauth === "object" ? (oauth as Record<string, unknown>).accessToken : undefined;
	if (typeof token !== "string" || !token.trim()) {
		throw new Error("Invalid credentials: expected a nonempty OAuth access token");
	}
	return content;
}

function hasCredentialOwner(path: string): boolean {
	const stat = inspectPath(path);
	if (!stat) return false;
	if (!stat.isFile() || readFileSync(path, "utf8") !== "shared-v1\n") {
		throw new Error("Invalid credential ownership marker");
	}
	return true;
}

function readFreshestCredentialPath(paths: ReturnType<typeof profilePaths>, name: string): string {
	// Supported writers replace CLI global/named files atomically; SDK refreshes the isolated file.
	// Compare file write time, not OAuth expiry: a later login may have a shorter lifetime.
	let selected = paths.saved;
	let newest = -Infinity;
	for (const path of [paths.isolated, paths.saved]) {
		requireRegularFile(path);
		const stat = inspectPath(path);
		if (stat && stat.mtimeMs > newest) {
			selected = path;
			newest = stat.mtimeMs;
		}
	}
	const live = join(paths.original, ".credentials.json");
	const liveStat = inspectPath(live);
	// An older global file cannot win, so its marker need not be readable for an isolated account.
	if (liveStat && liveStat.mtimeMs >= newest) {
		const marker = join(paths.original, ".active-profile");
		const active = inspectPath(marker) ? readFileSync(marker, "utf8").trim() : undefined;
		if (active === name && (selected !== paths.isolated || liveStat.mtimeMs > newest)) selected = live;
	}
	return selected;
}

function writeCredentials(path: string, content: string): void {
	requireRegularFile(path);
	// Replace atomically so an interrupted write cannot truncate the saved refresh token.
	const tempDir = mkdtempSync(join(dirname(path), ".bridge-credentials-"));
	try {
		chmodSync(tempDir, 0o700);
		const tempFile = join(tempDir, "credentials.json");
		writeFileSync(tempFile, content, { mode: 0o600 });
		renameSync(tempFile, path);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function shareConfigEntry(original: string, shared: string): void {
	let stat = inspectPath(shared);
	if (!stat) {
		try {
			symlinkSync(original, shared, "dir");
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// Another prepare may have published the link; validate its actual target below.
			stat = lstatSync(shared);
		}
	}
	// Restore sharing only for observed config files replaced with identical bytes.
	const replaceableFile = ["policy-limits.json", "remote-settings.json"].includes(basename(shared));
	if (
		replaceableFile &&
		stat.isFile() &&
		inspectPath(original)?.isFile() &&
		readFileSync(shared).equals(readFileSync(original))
	) {
		const tempDir = mkdtempSync(join(dirname(shared), ".bridge-config-"));
		try {
			const tempLink = join(tempDir, "shared");
			symlinkSync(original, tempLink);
			renameSync(tempLink, shared);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
		return;
	}
	// CC creates these under CLAUDE_CONFIG_DIR before a global counterpart may exist.
	// Preserve both directories; never merge native state or replace local contents.
	const nativeDirectory = ["skills", "plugins", "cache"].includes(basename(shared));
	if (nativeDirectory && stat.isDirectory() && inspectPath(original)?.isDirectory()) return;
	// Native login also creates or atomically replaces this account/cache file.
	// Keep both native files independent; never merge or replace their contents.
	if (basename(shared) === ".claude.json" && stat.isFile() && inspectPath(original)?.isFile()) return;
	if (!stat.isSymbolicLink() || resolve(dirname(shared), readlinkSync(shared)) !== original) {
		throw new Error("Account profile config path conflicts with the original config entry");
	}
}

// Claude writes signed-cache metadata beside each config file; only the config stays shared.
const profileLocalConfigEntries = new Set([
	"policy-limits.json.stamp.json",
	"policy-limits.json.signature.json",
	"policy-limits.json.signature-iat.json",
	"remote-settings.json.signature.json",
	"remote-settings.json.signature-iat.json",
]);

function shareConfig(original: string, configDir: string): void {
	mkdirSync(join(original, "projects"), { recursive: true, mode: 0o700 });
	for (const entry of readdirSync(original)) {
		if (profileLocalConfigEntries.has(entry)) continue;
		if (entry === ".credentials.json" || entry.endsWith(".credentials.json") || entry === ".active-profile") continue;
		shareConfigEntry(join(original, entry), join(configDir, entry));
	}
}

function reportFileError<T>(operation: string, name: string, action: () => T): T {
	try {
		return action();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code) {
			// Never include parser messages, credential contents, or raw filesystem errors.
			throw new Error(`Cannot ${operation} credentials for profile ${name}: ${code}`);
		}
		throw error;
	}
}

/** Read only: canonical after migration; legacy selection only before first preparation. */
export function readUsageCredentials(home: string, profile?: string, configDir?: string): unknown {
	try {
		if (profile === undefined) {
			return JSON.parse(readCredentials(join(configDir ?? join(home, ".claude"), ".credentials.json")));
		}
		const paths = profilePaths(home, profile);
		const source = hasCredentialOwner(paths.owner) ? paths.isolated : readFreshestCredentialPath(paths, profile);
		const content = readCredentials(source);
		return JSON.parse(content);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error("Missing Claude credentials for current account");
		}
		throw new Error("Invalid or unreadable Claude credentials for current account");
	}
}

/** Account selection shared by every bridge process. `rejected` holds Unix-second reset times. */
export interface AccountObservation {
	at: number;
	available: boolean;
	/** Latest successful proof, retained through later denials to bound their reset epoch. */
	recoveredAt?: number;
}

export interface AccountState {
	current?: string;
	rejected: Record<string, number>;
	observations?: Record<string, AccountObservation>;
}

function recoveryTimestamp(observation: AccountObservation): number {
	return observation.available ? observation.at : (observation.recoveredAt ?? -Infinity);
}

function latestObservation(previous: AccountObservation, incoming: AccountObservation): AccountObservation {
	if (previous.at > incoming.at) return previous;
	const denialWinsTie = previous.at === incoming.at && !previous.available;
	return denialWinsTie ? previous : incoming;
}

function mergeDenialReset(
	previous: AccountObservation,
	incoming: AccountObservation,
	previousReset: number | undefined,
	incomingReset: number | undefined,
): number | undefined {
	const previousRecovery = recoveryTimestamp(previous);
	const incomingRecovery = recoveryTimestamp(incoming);
	const recoveredAt = Math.max(previousRecovery, incomingRecovery);
	const oldReset = previous.available || previous.at < recoveredAt ? undefined : previousReset;
	const newReset = incoming.available || incoming.at < recoveredAt ? undefined : incomingReset;
	if (oldReset === undefined) return newReset;
	if (newReset === undefined) return oldReset;
	if (previousRecovery > incomingRecovery) return oldReset;
	if (incomingRecovery > previousRecovery) return newReset;
	return Math.max(oldReset, newReset);
}

/** Merge evidence by time and recovery epoch; denial wins ties, not file rewrite time. */
export function mergeAccountStates(previous: AccountState, incoming: AccountState): AccountState {
	const rejected = { ...previous.rejected };
	const observations = { ...previous.observations };
	const names = new Set([...Object.keys(incoming.rejected), ...Object.keys(incoming.observations ?? {})]);
	for (const name of names) {
		const observation = incoming.observations?.[name] ?? { at: 0, available: false };
		const old = observations[name] ?? { at: 0, available: false };
		const latest = latestObservation(old, observation);
		const recoveredAt = Math.max(recoveryTimestamp(old), recoveryTimestamp(observation));
		observations[name] = {
			at: latest.at,
			available: latest.available,
			...(!latest.available && Number.isFinite(recoveredAt) ? { recoveredAt } : {}),
		};
		const resetsAt = mergeDenialReset(old, observation, rejected[name], incoming.rejected[name]);
		if (resetsAt === undefined) delete rejected[name];
		else rejected[name] = resetsAt;
	}
	return {
		...(incoming.current === undefined ? {} : { current: incoming.current }),
		rejected,
		...(Object.keys(observations).length === 0 ? {} : { observations }),
	};
}

interface ProcessAccountState extends AccountState {
	/** Milliseconds; the newest selection across processes wins. */
	updatedAt: number;
}

/** One file per process, so every file has a single writer and concurrent updates are never lost. */
export function accountStateDir(home: string): string {
	return join(home, ".config", "pi-claude-bridge", "account-state");
}

function parseAccountObservation(entry: unknown): AccountObservation | undefined {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
	const { at, available, recoveredAt } = entry as { at?: unknown; available?: unknown; recoveredAt?: unknown };
	if (typeof at !== "number" || !Number.isFinite(at) || typeof available !== "boolean") return undefined;
	if (recoveredAt !== undefined && (typeof recoveredAt !== "number" || !Number.isFinite(recoveredAt)))
		return undefined;
	if (typeof recoveredAt === "number") return { at, available, recoveredAt };
	return { at, available };
}

function parseAccountObservations(value: unknown): Record<string, AccountObservation> | undefined {
	if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) return undefined;
	const observations: Record<string, AccountObservation> = {};
	for (const [name, entry] of Object.entries(value ?? {})) {
		const observation = parseAccountObservation(entry);
		if (!observation) return undefined;
		observations[name] = observation;
	}
	return observations;
}

function parseProcessAccountState(content: string): ProcessAccountState | undefined {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const { current, rejected, updatedAt, observations } = value as {
		current?: unknown;
		rejected?: unknown;
		updatedAt?: unknown;
		observations?: unknown;
	};
	if (current !== undefined && typeof current !== "string") return undefined;
	if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return undefined;
	if (!rejected || typeof rejected !== "object" || Array.isArray(rejected)) return undefined;
	const entries = Object.entries(rejected);
	if (entries.some(([, resetsAt]) => typeof resetsAt !== "number" || !Number.isFinite(resetsAt))) return undefined;
	const parsedObservations = parseAccountObservations(observations);
	if (!parsedObservations) return undefined;
	// Migration reads preserve old evidence instead of dating it at each subsequent rewrite.
	for (const [name] of entries) parsedObservations[name] ??= { at: updatedAt / 1000, available: false };
	const state: ProcessAccountState = {
		rejected: Object.fromEntries(entries) as Record<string, number>,
		updatedAt,
		...(Object.keys(parsedObservations).length === 0 ? {} : { observations: parsedObservations }),
	};
	if (typeof current === "string") state.current = current;
	return state;
}

function listProcessStateFiles(home: string): string[] {
	const dir = accountStateDir(home);
	if (!inspectPath(dir)) return [];
	return readdirSync(dir)
		.filter((name) => /^\d+\.json$/.test(name))
		.map((name) => join(dir, name));
}

/** A file version: replaced only by rename, so a new write always has a new inode. */
function fileVersion(path: string): string | undefined {
	const stat = inspectPath(path);
	return stat ? `${stat.ino}:${stat.mtimeMs}` : undefined;
}

/** Merged state plus the version of each file merged into it. */
function readMergedAccountState(home: string): { state: AccountState | undefined; merged: Map<string, string> } {
	const merged = new Map<string, string>();
	const files = listProcessStateFiles(home);
	if (files.length === 0) return { state: undefined, merged };
	let combined: AccountState = { rejected: {} };
	let newest: ProcessAccountState | undefined;
	for (const path of files) {
		// Version before content: a write landing in between leaves a newer version that pruning keeps.
		const version = fileVersion(path);
		let content: string;
		try {
			content = readFileSync(path, "utf8");
		} catch (error) {
			// Pruned by another process between listing and reading.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const state = parseProcessAccountState(content);
		if (!state) throw new Error(`Invalid Claude account state in ${path}; delete it to reset account selection`);
		if (version) merged.set(path, version);
		combined = mergeAccountStates(combined, state);
		if (state.current !== undefined && (!newest || state.updatedAt > newest.updatedAt)) newest = state;
	}
	const { current: _current, ...evidence } = combined;
	return { state: { ...evidence, ...(newest?.current === undefined ? {} : { current: newest.current }) }, merged };
}

/** Every process's state merged: newest account evidence and selection. Undefined before any write. */
export function readAccountState(home: string): AccountState | undefined {
	return readMergedAccountState(home).state;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Writes this process's file, then prunes files of exited processes whose exact merged version is carried
 * in `state`. A file rewritten after the read has a new version and stays for a later merge.
 */
function writeAccountState(home: string, state: AccountState, merged: Map<string, string>): void {
	const dir = accountStateDir(home);
	restrictDirectory(dirname(dir));
	restrictDirectory(dir);
	const tempDir = mkdtempSync(join(dir, ".write-"));
	try {
		const tempFile = join(tempDir, "state.json");
		writeFileSync(tempFile, `${JSON.stringify({ ...state, updatedAt: Date.now() })}\n`, { mode: 0o600 });
		renameSync(tempFile, join(dir, `${process.pid}.json`));
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
	for (const [path, version] of merged) {
		const pid = Number(path.slice(path.lastIndexOf("/") + 1, -".json".length));
		if (pid === process.pid || isProcessAlive(pid)) continue;
		if (fileVersion(path) === version) rmSync(path, { force: true });
	}
}

/** Applies `change` to the merged state and publishes the result as this process's state. */
export function updateAccountState(home: string, change: (state: AccountState | undefined) => AccountState): void {
	const { state, merged } = readMergedAccountState(home);
	writeAccountState(home, change(state), merged);
}

function migrateCredentials(home: string, name: string, paths: ReturnType<typeof profilePaths>): void {
	const owned = hasCredentialOwner(paths.owner);
	const contention = () => new Error(`Credential migration already in progress for profile ${name}`);
	if (inspectPath(paths.migration)) throw contention();
	if (owned) return;
	try {
		mkdirSync(paths.migration, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw contention();
		throw error;
	}
	try {
		// A peer may have completed migration between the first marker read and lock acquisition.
		if (hasCredentialOwner(paths.owner)) return;
		const source = readFreshestCredentialPath(paths, name);
		const selected = readCredentials(source);
		recordCredentialTrace({ home, name }, "prepare", identifyCredentialSource(paths, source));
		writeCredentials(paths.isolated, selected);
		writeCredentials(paths.owner, "shared-v1\n");
	} finally {
		rmSync(paths.migration, { recursive: true });
	}
}

/** Import legacy credentials once; every subsequent query shares the canonical native file. */
export function prepareAccountProfile(home: string, name: string): string {
	const paths = profilePaths(home, name);
	return reportFileError("read/prepare", name, () => {
		for (const dir of [paths.root, paths.profiles, paths.configDir]) restrictDirectory(dir);
		shareConfig(paths.original, paths.configDir);
		migrateCredentials(home, name, paths);
		readCredentials(paths.isolated);
		chmodSync(paths.isolated, 0o600);
		recordCredentialTrace({ home, name }, "prepared", "isolated");
		return paths.configDir;
	});
}
