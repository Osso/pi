import { spawn } from "node:child_process";

export interface DesktopNotification {
	body: string;
	title: string;
}

export type DesktopNotifier = (notification: DesktopNotification) => void;

export function sendDesktopNotification(notification: DesktopNotification): void {
	if (process.platform !== "linux") {
		return;
	}
	const child = spawn(
		"notify-send",
		["--app-name=Pi", "--expire-time=0", "--urgency=critical", notification.title, notification.body],
		{ detached: true, stdio: "ignore" },
	);
	child.on("error", () => undefined);
	child.unref();
}
