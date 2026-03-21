#!/usr/bin/env python3
import os
import pty
import select
import signal
import subprocess
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: pty_relay.py <command> [args...]", file=sys.stderr)
        return 2

    master_fd, slave_fd = pty.openpty()
    proc = subprocess.Popen(
        sys.argv[1:],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
        start_new_session=True,
    )
    os.close(slave_fd)

    def forward_signal(signum, _frame):
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signum)
            except ProcessLookupError:
                pass

    signal.signal(signal.SIGTERM, forward_signal)
    signal.signal(signal.SIGINT, forward_signal)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()

    try:
        stdin_open = True
        while True:
            if proc.poll() is not None:
                while True:
                    ready, _, _ = select.select([master_fd], [], [], 0)
                    if master_fd not in ready:
                        break
                    try:
                        data = os.read(master_fd, 65536)
                    except OSError:
                        data = b""
                    if not data:
                        break
                    os.write(stdout_fd, data)
                return int(proc.wait())

            read_list = [master_fd]
            if stdin_open:
                read_list.append(stdin_fd)

            ready, _, _ = select.select(read_list, [], [], 0.05)

            if master_fd in ready:
                try:
                    data = os.read(master_fd, 65536)
                except OSError:
                    data = b""
                if data:
                    os.write(stdout_fd, data)

            if stdin_open and stdin_fd in ready:
                try:
                    data = os.read(stdin_fd, 65536)
                except OSError:
                    data = b""
                if data:
                    os.write(master_fd, data)
                else:
                    stdin_open = False
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass

    return int(proc.wait())


if __name__ == "__main__":
    raise SystemExit(main())
