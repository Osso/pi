"""Two owned native detach PTYs; capture only the continuously foreground client."""

import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import sys
import termios
import time

root = Path(sys.argv[1])
dtach, runtime, fixture, scenario = sys.argv[2:6]
events_path = root / "events.jsonl"
socket = root / "dtach.sock"
clients = []
child_pid = None
captures = {}


def events():
    return [json.loads(line) for line in events_path.read_text().splitlines()]


def wait_event(name, after=0):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        matches = [event for event in events()[after:] if event["event"] == name]
        if matches:
            return matches[-1]
        time.sleep(0.01)
    raise AssertionError(f"Missing {name}: {events()}")


def attach(create=False):
    pid, master = pty.fork()
    if pid == 0:
        fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack("HHHH", 61, 299, 0, 0))
        # No provider, global Pi config, or auth discovery is involved in this fixture.
        os.environ.clear()
        os.environ.update({"TERM": "xterm-256color", "HOME": str(root), "PATH": "/usr/bin:/bin"})
        args = [dtach, "-c" if create else "-a", str(socket), "-r", "winch"]
        if create:
            args += [runtime, fixture, str(events_path)]
        os.execv(dtach, args)
    client = (pid, master)
    clients.append(client)
    return client


def capture(foreground, name):
    data = bytearray()
    deadline = time.monotonic() + 2
    quiet = time.monotonic() + 0.2
    # Drain both clients: the background client must not become a slow-reader test.
    while time.monotonic() < min(deadline, quiet):
        ready, _, _ = select.select([fd for _, fd in clients], [], [], 0.02)
        for fd in ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    raise AssertionError("detach client unexpectedly exited") from error
                raise
            if not chunk:
                raise AssertionError("detach client unexpectedly closed its PTY")
            if fd == foreground[1]:
                data.extend(chunk)
            quiet = time.monotonic() + 0.2
    captures[name] = data.decode("utf-8")
    (root / f"{name}.ansi").write_bytes(data)


try:
    events_path.write_text("")
    foreground = attach(create=True)
    child_pid = wait_event("ready")["pid"]
    capture(foreground, "initial")
    before = len(events())
    background = attach()
    wait_event("winch", before)
    capture(foreground, "secondAttach")

    before = len(events())
    os.write(foreground[1], b"\x1b[I")
    wait_event("received:\x1b[I", before)
    capture(foreground, "foregroundFocus")
    if scenario == "other-client-blur":
        before = len(events())
        os.write(background[1], b"\x1b[O")
        wait_event("received:\x1b[O", before)
    capture(foreground, "beforeMount")

    before = len(events())
    os.write(foreground[1], b"m")
    wait_event("mounted", before)
    capture(foreground, "mounted")

    before = len(events())
    fcntl.ioctl(foreground[1], termios.TIOCSWINSZ, struct.pack("HHHH", 46, 156, 0, 0))
    resized = wait_event("winch", before)
    assert (resized["columns"], resized["rows"]) == (156, 46), resized
    capture(foreground, "shrink")

    before = len(events())
    os.kill(child_pid, signal.SIGWINCH)
    wait_event("winch", before)
    capture(foreground, "sameSizeWinch")

    # Recovery is evidence that a real pending panel exists, not the expected fix.
    before = len(events())
    os.write(foreground[1], b"\x1b[I")
    wait_event("received:\x1b[I", before)
    capture(foreground, "recovered")
    before = len(events())
    os.write(foreground[1], b"\r")
    wait_event("answered", before)
    capture(foreground, "answered")
    result = {"captures": captures, "events": events(), "clients": [pid for pid, _ in clients]}
    (root / "result.json").write_text(json.dumps(result))
    print(json.dumps(result), flush=True)
finally:
    if child_pid:
        try:
            os.kill(child_pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    for pid, master in clients:
        os.close(master)
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    deadline = time.monotonic() + 3
    while socket.exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not socket.exists(), "owned detach master did not clean up"
    (root / "cleanup.json").write_text(json.dumps({"socketRemoved": not socket.exists(), "reapedClients": [pid for pid, _ in clients]}))
