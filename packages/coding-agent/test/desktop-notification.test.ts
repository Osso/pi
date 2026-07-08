import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS,
	NEVER_EXPIRE_DESKTOP_NOTIFICATION_MS,
	sendDesktopNotification,
} from "../src/core/desktop-notification.ts";

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: mocks.spawn,
}));

const mockedSpawn = vi.mocked(spawn);

function createChildProcess() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter & { setEncoding(encoding: BufferEncoding): void };
	};
	child.stdout = Object.assign(new EventEmitter(), {
		setEncoding: vi.fn<(encoding: BufferEncoding) => void>(),
	});
	return child;
}

describe("sendDesktopNotification", () => {
	beforeEach(() => {
		mockedSpawn.mockReset();
		mockedSpawn.mockReturnValue(createChildProcess() as ReturnType<typeof spawn>);
	});

	it("uses the spec default expiration when no duration is provided", () => {
		sendDesktopNotification({
			body: "Body",
			title: "Title",
		});

		expect(mockedSpawn).toHaveBeenCalledWith(
			"notify-send",
			expect.arrayContaining([`--expire-time=${DEFAULT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS}`]),
			expect.any(Object),
		);
	});

	it("preserves explicit non-expiring notifications", () => {
		sendDesktopNotification({
			body: "Body",
			expireTimeMs: NEVER_EXPIRE_DESKTOP_NOTIFICATION_MS,
			title: "Title",
		});

		expect(mockedSpawn).toHaveBeenCalledWith(
			"notify-send",
			expect.arrayContaining([`--expire-time=${NEVER_EXPIRE_DESKTOP_NOTIFICATION_MS}`]),
			expect.any(Object),
		);
	});
});
