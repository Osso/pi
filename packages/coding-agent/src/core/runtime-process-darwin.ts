import { createRequire } from "node:module";
import { join } from "node:path";
import { getPackageDir } from "../config.ts";

export interface DarwinProcessInfo {
	pid: number;
	startTimeTicks: number;
	state: "R" | "Z" | "X";
	processGroupId: number;
}

interface DarwinProcessBinding {
	readProcessInfo(pid: number): unknown;
}

const nativeRequire = createRequire(import.meta.url);
let binding: DarwinProcessBinding | undefined;

function loadDarwinProcessBinding(): DarwinProcessBinding {
	if (binding) return binding;
	if (process.arch !== "arm64" && process.arch !== "x64") {
		throw new Error(`Unsupported Darwin process architecture: ${process.arch}`);
	}
	const path = join(getPackageDir(), "native", "darwin", "prebuilds", `darwin-${process.arch}`, "process-info.node");
	const loaded: unknown = nativeRequire(path);
	if (loaded === null || typeof loaded !== "object" || !("readProcessInfo" in loaded)) {
		throw new Error(`Invalid Darwin process binding: ${path}`);
	}
	if (typeof loaded.readProcessInfo !== "function") throw new Error(`Invalid Darwin process binding: ${path}`);
	binding = loaded as DarwinProcessBinding;
	return binding;
}

function isDarwinProcessInfo(value: unknown, pid: number): value is DarwinProcessInfo {
	if (value === null || typeof value !== "object") return false;
	const info = value as Partial<DarwinProcessInfo>;
	const hasCreationMarker =
		typeof info.startTimeTicks === "number" && Number.isSafeInteger(info.startTimeTicks) && info.startTimeTicks > 0;
	const hasProcessGroup =
		typeof info.processGroupId === "number" && Number.isSafeInteger(info.processGroupId) && info.processGroupId >= 0;
	const hasKnownState = info.state === "R" || info.state === "Z" || info.state === "X";
	if (info.pid !== pid) return false;
	if (!hasCreationMarker || !hasProcessGroup) return false;
	return hasKnownState;
}

export function readDarwinProcessInfo(pid: number): DarwinProcessInfo {
	const info = loadDarwinProcessBinding().readProcessInfo(pid);
	if (!isDarwinProcessInfo(info, pid)) throw new Error(`Invalid native process information for PID ${pid}`);
	return info;
}
