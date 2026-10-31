#!/usr/bin/env python3
"""Panter runner phase-2 read-only AF_UNIX admission prototype.

It never executes work, grants, or commands. Linux-only SO_PEERCRED is checked
by the kernel before reading a message. No TCP listener or Node private APIs.
Not installed, enabled, or deployed by this PR.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import stat
import struct
import sys
from pathlib import Path
from typing import Any

MAX_REQUEST_BYTES = 16 * 1024
PEER_CRED_BYTES = struct.calcsize("3i")
DENIED = b'{"status":"DENIED"}\n'
READ_ONLY = b'{"version":1,"status":"READ_ONLY","executionEnabled":false}\n'


class AdmissionError(Exception):
    """Fixed messages, never include client-provided content."""


def validate_socket_path(path: str) -> Path:
    if not path or not os.path.isabs(path) or "\0" in path:
        raise AdmissionError("Invalid absolute socket path")
    target = Path(path)
    if target.name in ("", ".", "..") or len(os.fsencode(path)) > 100:
        raise AdmissionError("Invalid socket path")
    parent = target.parent
    try:
        info = os.lstat(parent)
    except OSError as exc:
        raise AdmissionError("Socket parent unavailable") from exc
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise AdmissionError("Socket parent must be private and owned by runner UID")
    # Never unlink a pre-existing path (including a symlink or another server).
    if os.path.lexists(target):
        raise AdmissionError("Refusing existing socket path")
    return target


def authorized_peer(conn: socket.socket, allowed_uid: int) -> bool:
    if not hasattr(socket, "SO_PEERCRED"):
        return False
    try:
        raw = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, PEER_CRED_BYTES)
        if len(raw) != PEER_CRED_BYTES:
            return False
        pid, uid, gid = struct.unpack("3i", raw)
        return pid > 0 and uid == allowed_uid and gid >= 0
    except (OSError, ValueError, struct.error):
        return False


def read_intent(conn: socket.socket) -> bool:
    conn.settimeout(2.0)
    message = bytearray()
    while len(message) <= MAX_REQUEST_BYTES:
        try:
            data = conn.recv(min(2048, MAX_REQUEST_BYTES + 1 - len(message)))
        except (OSError, TimeoutError):
            return False
        if not data:
            return False
        message.extend(data)
        if b"\n" in data:
            break
    if len(message) > MAX_REQUEST_BYTES or message.count(b"\n") != 1 or not message.endswith(b"\n"):
        return False
    try:
        decoded = json.loads(message[:-1].decode("utf-8", errors="strict"))
    except (UnicodeError, ValueError):
        return False
    return (type(decoded) is dict and set(decoded) == {"version", "operation"} and
            type(decoded["version"]) is int and decoded["version"] == 1 and
            decoded["operation"] == "runner.status")


def serve(socket_path: str, allowed_uid: int) -> None:
    if sys.platform != "linux" or not hasattr(socket, "SO_PEERCRED"):
        raise AdmissionError("Linux SO_PEERCRED required")
    if not isinstance(allowed_uid, int) or allowed_uid < 0:
        raise AdmissionError("Invalid allowlisted UID")
    target = validate_socket_path(socket_path)
    # The socket path is owned by the runner's UID; no group/world access.
    prior_umask = os.umask(0o177)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    cleanup_inode: int | None = None
    stopping = False

    def request_stop(_signal: int, _frame: Any) -> None:
        nonlocal stopping
        stopping = True

    prior_sigterm = signal.signal(signal.SIGTERM, request_stop)
    try:
        server.bind(str(target))
        os.chmod(target, 0o600, follow_symlinks=False)
        cleanup_inode = os.lstat(target).st_ino
        server.listen(8)
        server.settimeout(0.4)
        while not stopping:
            try:
                conn, _ = server.accept()
            except socket.timeout:
                continue
            except OSError:
                if stopping:
                    break
                raise
            with conn:
                # Do not read any client bytes before validating kernel identity.
                if not authorized_peer(conn, allowed_uid):
                    try:
                        conn.sendall(DENIED)
                    except OSError:
                        pass
                    continue
                is_status = read_intent(conn)
                try:
                    conn.sendall(READ_ONLY if is_status else DENIED)
                except OSError:
                    pass
    finally:
        server.close()
        os.umask(prior_umask)
        signal.signal(signal.SIGTERM, prior_sigterm)
        if cleanup_inode is not None:
            try:
                current = os.lstat(target)
                if stat.S_ISSOCK(current.st_mode) and current.st_ino == cleanup_inode:
                    os.unlink(target)
            except FileNotFoundError:
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Deny-by-default local runner admission (no execution)")
    parser.add_argument("--socket", required=True)
    parser.add_argument("--allow-uid", type=int, required=True)
    args = parser.parse_args()
    try:
        serve(args.socket, args.allow_uid)
        return 0
    except AdmissionError as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
