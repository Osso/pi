import { createHash } from "node:crypto";
import { closeSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../../src/config.ts";

export interface AuthTraceProfile {
	home: string;
	name: string;
}

type CredentialSource = "named" | "isolated" | "active";
type CredentialEvent = "prepare" | "prepared" | "persist" | "persisted" | "settled";
type AuthFailureKind =
	| "invalid_grant"
	| "refresh_unavailable"
	| "refresh_failed"
	| "lock_compromised"
	| "lock_contended"
	| "save_failed"
	| "authentication_failed";

interface CredentialMetadata {
	accessTokenPresent: boolean;
	refreshTokenPresent: boolean;
	accessFingerprint?: string;
	refreshFingerprint?: string;
	expiresAt?: number;
	refreshTokenExpiresAt?: number;
}

interface CredentialFileTrace extends Partial<CredentialMetadata> {
	state: "present" | "missing" | "unassociated" | "unreadable" | "invalid_json";
	modifiedAt?: number;
	inode?: number;
	errorCode?: string;
}

interface AuthFailure {
	kind: AuthFailureKind;
	httpStatus?: number;
}

const FINGERPRINT_HEX_LENGTH = 16;
const MAX_STDERR_RETAINED = 4096;
const lastObservations = new Map<string, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tokenFingerprint(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	return createHash("sha256").update(value).digest("hex").slice(0, FINGERPRINT_HEX_LENGTH);
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseCredentialMetadata(content: string): CredentialFileTrace {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		return { state: "invalid_json" };
	}
	const oauth = isRecord(value) && isRecord(value.claudeAiOauth) ? value.claudeAiOauth : undefined;
	const accessFingerprint = tokenFingerprint(oauth?.accessToken);
	const refreshFingerprint = tokenFingerprint(oauth?.refreshToken);
	return {
		state: "present",
		accessTokenPresent: accessFingerprint !== undefined,
		refreshTokenPresent: refreshFingerprint !== undefined,
		accessFingerprint,
		refreshFingerprint,
		expiresAt: finiteNumber(oauth?.expiresAt),
		refreshTokenExpiresAt: finiteNumber(oauth?.refreshTokenExpiresAt),
	};
}

function safeErrorCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException).code;
	return typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : "unknown";
}

function traceReadError(error: unknown): CredentialFileTrace {
	const code = safeErrorCode(error);
	if (code === "ENOENT") return { state: "missing" };
	return { state: "unreadable", errorCode: code };
}

function readCredentialFile(path: string): CredentialFileTrace {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, "r");
		const stat = fstatSync(descriptor);
		return {
			...parseCredentialMetadata(readFileSync(descriptor, "utf8")),
			modifiedAt: stat.mtimeMs,
			inode: stat.ino,
		};
	} catch (error) {
		return traceReadError(error);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function readAssociatedActive(profile: AuthTraceProfile): CredentialFileTrace {
	const original = join(profile.home, ".claude");
	try {
		if (readFileSync(join(original, ".active-profile"), "utf8").trim() !== profile.name)
			return { state: "unassociated" };
	} catch (error) {
		const observed = traceReadError(error);
		return observed.state === "missing" ? { state: "unassociated" } : observed;
	}
	return readCredentialFile(join(original, ".credentials.json"));
}

function readProfileFiles(profile: AuthTraceProfile) {
	return {
		named: readCredentialFile(join(profile.home, ".claude", `${profile.name}.credentials.json`)),
		isolated: readCredentialFile(
			join(profile.home, ".config", "pi-claude-bridge", "profiles", profile.name, ".credentials.json"),
		),
		active: readAssociatedActive(profile),
	};
}

function appendPrivateTrace(line: string): void {
	const path = join(getAgentDir(), "claude-bridge-auth.jsonl");
	mkdirSync(dirname(path), { recursive: true });
	const descriptor = openSync(path, "a", 0o600);
	try {
		fchmodSync(descriptor, 0o600);
		writeFileSync(descriptor, line);
	} finally {
		closeSync(descriptor);
	}
}

function appendTrace(
	profile: AuthTraceProfile,
	event: CredentialEvent | "oauth_failure",
	source?: CredentialSource,
	failure?: AuthFailure,
): void {
	try {
		const observation = { event, source, failure, files: readProfileFiles(profile) };
		const key = `${profile.home}/${profile.name}/${event}/${failure?.kind ?? ""}`;
		const signature = JSON.stringify(observation);
		if (lastObservations.get(key) === signature) return;
		const entry = { timestamp: new Date().toISOString(), pid: process.pid, profile: profile.name, ...observation };
		appendPrivateTrace(JSON.stringify(entry) + "\n");
		lastObservations.set(key, signature);
	} catch (error) {
		console.error(`Cannot write Claude authentication trace (${safeErrorCode(error)})`);
	}
}

export function recordCredentialTrace(
	profile: AuthTraceProfile,
	event: CredentialEvent,
	source?: CredentialSource,
): void {
	appendTrace(profile, event, source);
}

const AUTH_FAILURE_PATTERNS: readonly [RegExp, AuthFailureKind][] = [
	[/invalid_grant/i, "invalid_grant"],
	[/lock compromised/i, "lock_compromised"],
	[/another.*process.*refresh|refresh.*lock.*(?:timeout|contended)/i, "lock_contended"],
	[/failed to save oauth|save.*oauth.*(?:failed|exception)|oauth.*save.*failed/i, "save_failed"],
	[/session expired.*could not be refreshed|no.refresh.token/i, "refresh_unavailable"],
	[/refresh.*failed|failed.*refresh/i, "refresh_failed"],
	[/failed to authenticate|authentication.failed/i, "authentication_failed"],
];

function classifyAuthFailure(text: string): AuthFailure | undefined {
	if (!/oauth|authenticat|refresh token/i.test(text)) return undefined;
	const matched = AUTH_FAILURE_PATTERNS.find(([pattern]) => pattern.test(text));
	if (!matched) return undefined;
	const status = /\b(?:HTTP|status(?: code)?)\s*[:=]?\s*([45]\d{2})\b/i.exec(text);
	return { kind: matched[1], ...(status ? { httpStatus: Number(status[1]) } : {}) };
}

export function recordAuthFailure(profile: AuthTraceProfile | undefined, text: string | undefined): void {
	if (profile === undefined || text === undefined) return;
	const failure = classifyAuthFailure(text);
	if (failure) appendTrace(profile, "oauth_failure", undefined, failure);
}

export function createAuthStderrRecorder(profile: AuthTraceProfile): (data: string) => void {
	let pending = "";
	return (data) => {
		const lines = (pending + data).split(/\r?\n/);
		pending = lines.pop() ?? "";
		for (const line of lines) recordAuthFailure(profile, line);
		if (pending) recordAuthFailure(profile, pending);
		pending = pending.slice(-MAX_STDERR_RETAINED);
	};
}
