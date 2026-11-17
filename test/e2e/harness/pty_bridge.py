#!/usr/bin/env python3
"""PTY supervisor bridging raw terminal bytes over JSON-lines for E2E tests."""

from __future__ import annotations

import base64
import binascii
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time
from typing import Any

SIGNAL_MAP: dict[str, int] = {
    "SIGTERM": signal.SIGTERM,
    "SIGINT": signal.SIGINT,
    "SIGHUP": signal.SIGHUP,
    "SIGKILL": signal.SIGKILL,
    "SIGUSR1": signal.SIGUSR1,
}

VMRSS_RE = re.compile(r"^VmRSS:\s*(\d+)\s*kB", re.MULTILINE)


def parse_args(argv: list[str]) -> tuple[int, int, str | None, list[str]]:
    cols = 120
    rows = 40
    cwd: str | None = None
    i = 0
    n = len(argv)
    sep_found = False
    while i < n:
        arg = argv[i]
        if arg == "--":
            i += 1
            sep_found = True
            break
        if arg == "--cols":
            if i + 1 >= n:
                raise ValueError("--cols requires an integer argument")
            cols = int(argv[i + 1])
            i += 2
        elif arg == "--rows":
            if i + 1 >= n:
                raise ValueError("--rows requires an integer argument")
            rows = int(argv[i + 1])
            i += 2
        elif arg == "--cwd":
            if i + 1 >= n:
                raise ValueError("--cwd requires a path argument")
            cwd = argv[i + 1]
            i += 2
        else:
            raise ValueError(f"Unknown bridge argument: {arg}")

    if not sep_found or i >= n:
        raise ValueError("Missing command after '--'")
    if cols < 1 or rows < 1:
        raise ValueError("cols and rows must be >= 1")
    return cols, rows, cwd, argv[i:]


def emit_event(payload: dict[str, Any]) -> bool:
    line = (json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8")
    try:
        view = memoryview(line)
        sent = 0
        while sent < len(line):
            try:
                written = os.write(1, view[sent:])
                if written == 0:
                    return False
                sent += written
            except BlockingIOError:
                _, w, _ = select.select([], [1], [], 0.1)
                if not w:
                    return False
            except InterruptedError:
                continue
        return True
    except (BrokenPipeError, OSError):
        return False


def kill_pg(pid: int, sig: int) -> None:
    try:
        os.killpg(pid, sig)
    except (ProcessLookupError, PermissionError, OSError):
        pass


def set_winsize(fd: int, rows: int, cols: int) -> None:
    winsz = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsz)


def read_vm_rss_kb(pid: int) -> int | None:
    try:
        with open(f"/proc/{pid}/status", "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return None
    match = VMRSS_RE.search(text)
    if not match:
        return None
    return int(match.group(1))


def decode_wait_status(status: int) -> tuple[int | None, str | None]:
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status), None
    if os.WIFSIGNALED(status):
        sig_num = os.WTERMSIG(status)
        try:
            sig_name = signal.Signals(sig_num).name
        except ValueError:
            sig_name = f"SIG{sig_num}"
        return None, sig_name
    return 1, None


def main() -> int:
    try:
        cols, rows, cwd, cmd = parse_args(sys.argv[1:])
    except ValueError as exc:
        sys.stderr.write(f"pty_bridge.py: {exc}\n")
        return 2

    master_fd, slave_fd = pty.openpty()
    set_winsize(slave_fd, rows, cols)

    pid = os.fork()
    if pid == 0:
        try:
            os.close(master_fd)
            os.setsid()
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
            set_winsize(slave_fd, rows, cols)
            os.dup2(slave_fd, 0)
            os.dup2(slave_fd, 1)
            os.dup2(slave_fd, 2)
            if slave_fd > 2:
                os.close(slave_fd)
            signal.signal(signal.SIGPIPE, signal.SIG_DFL)
            if cwd is not None:
                os.chdir(cwd)
            os.execvp(cmd[0], cmd)
        except OSError as exc:
            msg = f"pty_bridge.py exec failed for {cmd[0]}: {exc}\n".encode("utf-8", errors="replace")
            try:
                os.write(2, msg)
            except OSError:
                pass
            os._exit(127)
        os._exit(127)

    os.close(slave_fd)
    os.set_blocking(master_fd, False)
    stdin_fd = sys.stdin.fileno()
    os.set_blocking(stdin_fd, False)

    cur_cols = cols
    cur_rows = rows
    pty_write_buf = bytearray()
    stdin_buf = bytearray()
    pty_eof = False
    stdin_eof = False
    reaped_status: int | None = None
    exit_time: float | None = None
    pty_eof_time: float | None = None
    teardown_requested = False
    kill_deadline: float | None = None
    sigterm_sent = False
    sigkill_sent = False
    broken_pipe = False

    def request_teardown(grace_ms: int = 500) -> None:
        nonlocal teardown_requested, kill_deadline, sigterm_sent
        teardown_requested = True
        if not sigterm_sent:
            kill_pg(pid, signal.SIGTERM)
            sigterm_sent = True
        deadline = time.monotonic() + max(0, grace_ms) / 1000.0
        if kill_deadline is None or deadline < kill_deadline:
            kill_deadline = deadline

    def on_supervisor_signal(_signum: int, _frame: Any) -> None:
        request_teardown(500)

    signal.signal(signal.SIGTERM, on_supervisor_signal)
    signal.signal(signal.SIGINT, on_supervisor_signal)

    if not emit_event({"type": "started", "pid": pid, "cols": cur_cols, "rows": cur_rows}):
        broken_pipe = True
        request_teardown(200)

    def handle_command(raw_line: bytes) -> None:
        nonlocal cur_cols, cur_rows, broken_pipe
        text = raw_line.decode("utf-8", errors="replace").strip()
        if not text:
            return
        try:
            msg = json.loads(text)
        except json.JSONDecodeError as exc:
            if not emit_event({"type": "error", "message": f"invalid JSON: {exc}"}):
                broken_pipe = True
                request_teardown(200)
            return

        if not isinstance(msg, dict):
            emit_event({"type": "error", "message": "command must be a JSON object"})
            return

        op = msg.get("op")
        if op == "write":
            data_b64 = msg.get("data")
            if not isinstance(data_b64, str):
                emit_event({"type": "error", "message": "write op requires string 'data'"})
                return
            try:
                raw = base64.b64decode(data_b64, validate=True)
            except (binascii.Error, ValueError) as exc:
                emit_event({"type": "error", "message": f"invalid base64 in write: {exc}"})
                return
            pty_write_buf.extend(raw)
        elif op == "resize":
            raw_cols = msg.get("cols")
            raw_rows = msg.get("rows")
            if not isinstance(raw_cols, int) or not isinstance(raw_rows, int):
                emit_event({"type": "error", "message": "resize op requires integer 'cols' and 'rows'"})
                return
            next_cols = max(1, raw_cols)
            next_rows = max(1, raw_rows)
            try:
                set_winsize(master_fd, next_rows, next_cols)
                if (next_rows, next_cols) == (cur_rows, cur_cols):
                    kill_pg(pid, signal.SIGWINCH)
                cur_cols = next_cols
                cur_rows = next_rows
            except OSError as exc:
                emit_event({"type": "error", "message": f"resize ioctl failed: {exc}"})
                return
            ev: dict[str, Any] = {"type": "resized", "cols": cur_cols, "rows": cur_rows}
            if "id" in msg:
                ev["id"] = msg["id"]
            if not emit_event(ev):
                broken_pipe = True
                request_teardown(200)
        elif op == "rss":
            kb = read_vm_rss_kb(pid) if reaped_status is None else None
            ev = {"type": "rss", "pid": pid, "kb": kb}
            if "id" in msg:
                ev["id"] = msg["id"]
            if not emit_event(ev):
                broken_pipe = True
                request_teardown(200)
        elif op == "signal":
            sig_name = msg.get("sig")
            if not isinstance(sig_name, str) or sig_name not in SIGNAL_MAP:
                emit_event({"type": "error", "message": f"unsupported signal: {sig_name!r}"})
                return
            kill_pg(pid, SIGNAL_MAP[sig_name])
        elif op == "kill":
            raw_grace = msg.get("graceMs", 500)
            grace_ms = raw_grace if isinstance(raw_grace, int) and raw_grace >= 0 else 500
            request_teardown(grace_ms)
        else:
            emit_event({"type": "error", "message": f"unknown op: {op!r}"})

    while not broken_pipe:
        rlist: list[int] = []
        wlist: list[int] = []
        if not pty_eof:
            rlist.append(master_fd)
            if len(pty_write_buf) > 0:
                wlist.append(master_fd)
        if not stdin_eof:
            rlist.append(stdin_fd)

        timeout = 0.05 if (teardown_requested or reaped_status is not None or pty_eof) else 0.1
        if rlist or wlist:
            try:
                ready_r, ready_w, _ = select.select(rlist, wlist, [], timeout)
            except InterruptedError:
                ready_r, ready_w = [], []
        else:
            ready_r, ready_w = [], []
            time.sleep(0.01)

        if master_fd in ready_r:
            while True:
                try:
                    chunk = os.read(master_fd, 65536)
                except OSError as exc:
                    if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EINTR):
                        break
                    if exc.errno in (errno.EIO, errno.EBADF):
                        pty_eof = True
                        if pty_eof_time is None:
                            pty_eof_time = time.monotonic()
                        break
                    raise
                if not chunk:
                    pty_eof = True
                    if pty_eof_time is None:
                        pty_eof_time = time.monotonic()
                    break
                if not emit_event({"type": "data", "data": base64.b64encode(chunk).decode("ascii")}):
                    broken_pipe = True
                    request_teardown(200)
                    break

        if master_fd in ready_w and len(pty_write_buf) > 0 and not pty_eof:
            try:
                written = os.write(master_fd, pty_write_buf)
                if written > 0:
                    del pty_write_buf[:written]
            except BlockingIOError:
                pass
            except OSError as exc:
                if exc.errno in (errno.EIO, errno.EBADF, errno.EPIPE):
                    pty_write_buf.clear()
                    pty_eof = True
                    if pty_eof_time is None:
                        pty_eof_time = time.monotonic()

        if stdin_fd in ready_r:
            while True:
                try:
                    chunk = os.read(stdin_fd, 65536)
                except OSError as exc:
                    if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EINTR):
                        break
                    stdin_eof = True
                    request_teardown(500)
                    break
                if not chunk:
                    stdin_eof = True
                    request_teardown(500)
                    break
                stdin_buf.extend(chunk)
                while True:
                    nl = stdin_buf.find(b"\n")
                    if nl < 0:
                        break
                    line = bytes(stdin_buf[:nl])
                    del stdin_buf[: nl + 1]
                    handle_command(line)

        if reaped_status is None:
            try:
                wpid, st = os.waitpid(pid, os.WNOHANG)
                if wpid == pid:
                    reaped_status = st
                    exit_time = time.monotonic()
            except ChildProcessError:
                reaped_status = 0
                exit_time = time.monotonic()

        now = time.monotonic()
        if teardown_requested and kill_deadline is not None and now >= kill_deadline and not sigkill_sent:
            kill_pg(pid, signal.SIGKILL)
            sigkill_sent = True

        if reaped_status is not None:
            assert exit_time is not None
            if pty_eof or (now - exit_time) >= 0.25:
                break
        elif pty_eof and pty_eof_time is not None and teardown_requested and (now - pty_eof_time) >= 0.5:
            if not sigkill_sent:
                kill_pg(pid, signal.SIGKILL)
                sigkill_sent = True
            break

    if reaped_status is None:
        if not sigterm_sent:
            kill_pg(pid, signal.SIGTERM)
            sigterm_sent = True
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            try:
                wpid, st = os.waitpid(pid, os.WNOHANG)
                if wpid == pid:
                    reaped_status = st
                    break
            except ChildProcessError:
                reaped_status = 0
                break
            time.sleep(0.02)
        if reaped_status is None:
            kill_pg(pid, signal.SIGKILL)
            try:
                _, reaped_status = os.waitpid(pid, 0)
            except ChildProcessError:
                reaped_status = 0

    exit_code, exit_sig = decode_wait_status(reaped_status)
    if not broken_pipe:
        emit_event({"type": "exit", "code": exit_code, "signal": exit_sig})

    try:
        os.close(master_fd)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
