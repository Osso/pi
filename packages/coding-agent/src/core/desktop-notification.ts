import { spawn } from "node:child_process";

export const DEFAULT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS = -1;
export const NEVER_EXPIRE_DESKTOP_NOTIFICATION_MS = 0;
export const PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS = 999_999;

export interface DesktopNotification {
	body: string;
	expireTimeMs?: number;
	title: string;
	urgency?: "critical" | "low" | "normal";
}

export interface DesktopNotificationHandle {
	close(): void;
}

export type DesktopNotifier = (notification: DesktopNotification) => undefined | DesktopNotificationHandle;

export function toDesktopNotificationHandle(
	value: undefined | DesktopNotificationHandle,
): DesktopNotificationHandle | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	return typeof value.close === "function" ? value : undefined;
}

export function sendDesktopNotification(notification: DesktopNotification): DesktopNotificationHandle | undefined {
	if (process.platform !== "linux") {
		return undefined;
	}

	const pendingNotification = createPendingDesktopNotification();
	const expireTimeMs = notification.expireTimeMs ?? DEFAULT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS;
	const urgency = notification.urgency ?? "critical";
	const child = spawn(
		"notify-send",
		[
			"--print-id",
			"--app-name=Pi",
			`--expire-time=${expireTimeMs}`,
			`--urgency=${urgency}`,
			notification.title,
			notification.body,
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	let output = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		output += chunk;
	});
	child.on("error", () => undefined);
	child.on("close", () => {
		const notificationId = parseNotificationId(output);
		if (notificationId !== undefined) {
			pendingNotification.resolve(notificationId);
		}
	});
	return pendingNotification.handle;
}

function createPendingDesktopNotification(): {
	handle: DesktopNotificationHandle;
	resolve(notificationId: number): void;
} {
	let closeRequested = false;
	let resolvedNotificationId: number | undefined;

	return {
		handle: {
			close: () => {
				closeRequested = true;
				if (resolvedNotificationId !== undefined) {
					closeDesktopNotification(resolvedNotificationId);
				}
			},
		},
		resolve: (notificationId) => {
			resolvedNotificationId = notificationId;
			if (closeRequested) {
				closeDesktopNotification(notificationId);
			}
		},
	};
}

function parseNotificationId(output: string): number | undefined {
	const match = output.match(/^\s*(\d+)/);
	if (!match) {
		return undefined;
	}

	const notificationId = Number(match[1]);
	return Number.isSafeInteger(notificationId) ? notificationId : undefined;
}

function closeDesktopNotification(notificationId: number): void {
	const child = spawn(
		"busctl",
		[
			"--user",
			"call",
			"org.freedesktop.Notifications",
			"/org/freedesktop/Notifications",
			"org.freedesktop.Notifications",
			"CloseNotification",
			"u",
			String(notificationId),
		],
		{ detached: true, stdio: "ignore" },
	);
	child.on("error", () => undefined);
	child.unref();
}
