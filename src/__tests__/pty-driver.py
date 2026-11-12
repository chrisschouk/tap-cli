"""Run a command in a pseudo-terminal and drive it with keys.

    python3 -I pty-driver.py <rows> <cols> -- <command...>

stdin holds a JSON list of steps: {"wait": "text"} reads until the text shows
up after the previous wait, {"send": "keys"} types them. Everything the
command drew goes to stdout; the exit code is the command's, or 124 when a
wait times out.
"""

import fcntl
import json
import os
import pty
import select
import struct
import sys
import termios
import time

TIMEOUT_S = 15


def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def read_some(fd, timeout):
    ready, _, _ = select.select([fd], [], [], timeout)
    if not ready:
        return b""
    try:
        return os.read(fd, 65536) or None
    except OSError:
        return None


def main():
    rows, cols = int(sys.argv[1]), int(sys.argv[2])
    command = sys.argv[sys.argv.index("--") + 1:]
    steps = json.loads(sys.stdin.read() or "[]")

    pid, fd = pty.fork()
    if pid == 0:
        set_size(0, rows, cols)
        os.execvp(command[0], command)

    seen = b""
    mark = 0
    code = None
    for step in steps:
        if "send" in step:
            time.sleep(0.05)
            os.write(fd, step["send"].encode())
            continue
        wanted = step["wait"].encode()
        deadline = time.time() + TIMEOUT_S
        while wanted not in seen[mark:]:
            chunk = read_some(fd, 0.2)
            if chunk is None or time.time() > deadline:
                sys.stdout.write(seen.decode(errors="replace"))
                sys.stdout.write(f"\n[pty-driver] timed out waiting for {step['wait']!r}\n")
                os.kill(pid, 9)
                sys.exit(124)
            seen += chunk
        mark = seen.index(wanted, mark) + len(wanted)

    while True:
        chunk = read_some(fd, 0.2)
        if chunk is None:
            break
        seen += chunk
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            code = os.waitstatus_to_exitcode(status)
    if code is None:
        code = os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
    sys.stdout.write(seen.decode(errors="replace"))
    sys.exit(code)


main()
