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
dtach, node, child = sys.argv[2:5]
events_path = root / 'events.jsonl'
socket = root / 'dtach.sock'
clients = []
child_pid = None
captures = {}


def events():
    return [json.loads(line) for line in events_path.read_text().splitlines()]


def wait_event(name, after=0):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        matches = [event for event in events()[after:] if event['event'] == name]
        if matches:
            return matches[-1]
        time.sleep(0.01)
    raise AssertionError(f'Missing {name}: {events()}')


def attach(columns, create=False):
    pid, master = pty.fork()
    if pid == 0:
        fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack('HHHH', 10, columns, 0, 0))
        os.environ['TERM'] = 'xterm-256color'
        os.environ.pop('TERMUX_VERSION', None)
        args = [dtach, '-c' if create else '-a', str(socket), '-r', 'winch']
        if create:
            args += [node, child, str(events_path)]
        os.execvp(dtach, args)
    client = (pid, master)
    clients.append(client)
    return client


def capture(client, name):
    data = bytearray()
    deadline = time.monotonic() + 2
    quiet = time.monotonic() + 0.2
    while time.monotonic() < min(deadline, quiet):
        ready, _, _ = select.select([client[1]], [], [], 0.02)
        if not ready:
            continue
        try:
            chunk = os.read(client[1], 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        data.extend(chunk)
        quiet = time.monotonic() + 0.2
    captures[name] = data.decode('utf-8')


def detach(client):
    os.write(client[1], b'\x1c')
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        pid, status = os.waitpid(client[0], os.WNOHANG)
        if pid:
            assert os.waitstatus_to_exitcode(status) == 0
            os.close(client[1])
            clients.remove(client)
            return
        time.sleep(0.01)
    raise AssertionError('dtach did not detach')


try:
    events_path.write_text('')
    client = attach(40, create=True)
    child_pid = wait_event('ready')['pid']
    capture(client, 'initial')
    for index in range(2):
        detach(client)
        before = len(events())
        client = attach(40)
        wait_event('SIGWINCH', before)
        capture(client, f'attach{index}')
        before = len(events())
        os.write(client[1], b'u')
        wait_event('input:u', before)
        capture(client, f'update{index}')

    detach(client)
    before = len(events())
    client = attach(41)
    wait_event('stdout:resize', before)
    capture(client, 'changed')

    before = len(events())
    os.write(client[1], b's')
    stopped = wait_event('input:s', before)
    capture(client, 'stopped')
    before = len(events())
    os.kill(child_pid, signal.SIGWINCH)
    wait_event('SIGWINCH', before)
    capture(client, 'stoppedSignal')

    before = len(events())
    os.kill(child_pid, signal.SIGUSR1)
    wait_event('restarted', before)
    capture(client, 'restarted')
    before = len(events())
    os.kill(child_pid, signal.SIGWINCH)
    wait_event('SIGWINCH', before)
    capture(client, 'restartedSignal')
    print(json.dumps({'captures': captures, 'events': events()}), flush=True)
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
    deadline = time.monotonic() + 2
    while socket.exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not socket.exists(), 'dtach server did not clean up'
