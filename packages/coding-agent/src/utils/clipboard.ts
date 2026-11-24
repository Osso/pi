import { execSync, spawn } from "child_process";
import { platform } from "os";
import { isWaylandSession } from "./clipboard-image.ts";
import { clipboard } from "./clipboard-native.ts";

type NativeClipboardExecOptions = {
	input: string;
	timeout: number;
	stdio: ["pipe", "ignore", "ignore"];
};

/**
 * Run a clipboard writer that daemonizes to keep selection ownership. Detached, the daemon leaves pi's process group,
 * so Ctrl+Z (SIGTSTP to the group) does not stop the clipboard owner (#11179).
 */
function runDetachedClipboardWriter(command: string, args: string[], text: string): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], detached: true });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve(false);
		}, 5000);
		const finish = (ok: boolean) => {
			clearTimeout(timer);
			resolve(ok);
		};
		child.on("error", () => finish(false));
		child.on("close", (code) => finish(code === 0));
		child.stdin.on("error", () => {}); // A writer may exit before consuming all input.
		child.stdin.end(text);
	});
}

async function copyToX11Clipboard(text: string): Promise<boolean> {
	return (
		(await runDetachedClipboardWriter("xclip", ["-selection", "clipboard"], text)) ||
		(await runDetachedClipboardWriter("xsel", ["--clipboard", "--input"], text))
	);
}

const MAX_OSC52_ENCODED_LENGTH = 100_000;

function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

export async function copyToClipboard(text: string): Promise<void> {
	let copied = false;

	const p = platform();

	// Prefer direct clipboard writes. Emitting OSC 52 first can make terminals
	// write the same native clipboard concurrently with the addon, and very large
	// OSC 52 payloads can desynchronize terminal rendering.
	//
	// On Linux, skip the native addon. The underlying `clipboard-rs` crate is
	// X11-only and does not retain selection ownership after `set_text`
	// resolves, so on Wayland-only compositors (Hyprland, Niri, ...) and even
	// some X11 sessions the call resolves successfully without populating the
	// clipboard. The platform tools below (wl-copy, xclip, xsel) properly
	// daemonize and keep ownership.
	try {
		if (clipboard && p !== "linux") {
			await clipboard.setText(text);
			copied = true;
		}
	} catch {
		// Fall through to platform-specific clipboard tools.
	}

	const remote = isRemoteSession();
	if (copied && !remote) {
		return;
	}

	const options: NativeClipboardExecOptions = { input: text, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] };

	if (!copied) {
		try {
			if (p === "darwin") {
				execSync("pbcopy", options);
				copied = true;
			} else if (p === "win32") {
				execSync("clip", options);
				copied = true;
			} else {
				// Linux. Try Termux, Wayland, or X11 clipboard tools.
				if (process.env.TERMUX_VERSION) {
					try {
						execSync("termux-clipboard-set", options);
						copied = true;
					} catch {
						// Fall back to Wayland or X11 tools.
					}
				}

				if (!copied) {
					const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
					const hasX11Display = Boolean(process.env.DISPLAY);
					const isWayland = isWaylandSession();
					if (isWayland && hasWaylandDisplay) {
						// wl-copy forks a daemon that keeps selection ownership; its exit status reports the copy.
						copied = await runDetachedClipboardWriter("wl-copy", ["-t", "text/plain"], text);
						if (!copied && hasX11Display) copied = await copyToX11Clipboard(text);
					} else if (hasX11Display) {
						copied = await copyToX11Clipboard(text);
					}
				}
			}
		} catch {
			// Fall through to OSC 52 fallback.
		}
	}

	if (remote || !copied) {
		const osc52Copied = emitOsc52(text);
		copied = copied || osc52Copied;
	}

	if (!copied) {
		throw new Error("Failed to copy to clipboard");
	}
}
