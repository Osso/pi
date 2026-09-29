"""Run one argv-specified CLI in a PTY and relay bytes over stdio."""

import fcntl
import os
import select
import signal
import struct
import subprocess
import sys
import termios


def main():
    rows, columns = map(int, sys.argv[1:3])
    master, slave = os.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    child = subprocess.Popen(sys.argv[3:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)

    def terminate(_signal, _frame):
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    try:
        while True:
            ready, _, _ = select.select([master, sys.stdin.fileno()], [], [], 0.1)
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break  # Linux PTY returns EIO when slave closes.
                if not data:
                    break
                os.write(sys.stdout.fileno(), data)
            if sys.stdin.fileno() in ready:
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    terminate(None, None)
                    break
                os.write(master, data)
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
        child.wait()
        os.close(master)


if __name__ == "__main__":
    main()
